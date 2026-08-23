import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { createGeminiMediaEdgeRuntime } from "./runtime.mjs";
import { createHmacCredentialVerifier, InMemoryOneShotCredentialConsumer } from "./credential.mjs";
import { InMemoryBootstrapRegistry } from "./bootstrap.mjs";
import { InMemoryControlSidebandRegistry } from "./control-sideband.mjs";
import { createCloudRunAccessTokenProvider, createGoogleSpeechV2Transcriber } from "./google-speech.mjs";

function required(value, field) { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`); return value.trim(); }
function positiveNumber(value, field, options = {}) { const number = Number(value); if (!Number.isFinite(number) || (options.allowZero ? number < 0 : number <= 0)) throw new Error(`${field} must be a valid number`); return number; }
function secureTokenEqual(actual, expected) { const left = Buffer.from(actual ?? "", "utf8"); const right = Buffer.from(expected, "utf8"); return left.length === right.length && timingSafeEqual(left, right); }
async function readJsonBody(request, maxBytes = 262_144) { const chunks = []; let total = 0; for await (const chunk of request) { total += chunk.length; if (total > maxBytes) throw new Error("Gemini media edge bootstrap body is too large"); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Gemini media edge bootstrap body is invalid JSON"); } }
function controlAuthorization(request, expected) { const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization.trim() : ""; const supplied = authorization.replace(/^Bearer\s+/i, ""); return /^Bearer\s+/i.test(authorization) && secureTokenEqual(supplied, expected); }
function languageCodes(value) { const codes = required(value, "GOOGLE_SPEECH_LANGUAGE_CODES").split(",").map((item) => item.trim()).filter(Boolean); if (!codes.length || new Set(codes).size !== codes.length) throw new Error("GOOGLE_SPEECH_LANGUAGE_CODES is invalid"); return codes; }

const port = Number(process.env.PORT ?? "8080"); if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid TCP port");
if (process.env.MEDIA_EDGE_SINGLE_INSTANCE !== "true") throw new Error("MEDIA_EDGE_SINGLE_INSTANCE=true is required until durable shared credential/bootstrap stores are configured");
const controlPlaneToken = required(process.env.MEDIA_EDGE_CONTROL_PLANE_TOKEN, "MEDIA_EDGE_CONTROL_PLANE_TOKEN"); if (Buffer.byteLength(controlPlaneToken, "utf8") < 32) throw new Error("MEDIA_EDGE_CONTROL_PLANE_TOKEN must be at least 32 bytes");
const credentialConsumer = new InMemoryOneShotCredentialConsumer(); const bootstrapRegistry = new InMemoryBootstrapRegistry(); const controlRegistry = new InMemoryControlSidebandRegistry();
const verifyCredential = createHmacCredentialVerifier(process.env.MEDIA_EDGE_CREDENTIAL_HMAC_SECRET, process.env.MEDIA_EDGE_PUBLIC_URL);
const accessTokenProvider = createCloudRunAccessTokenProvider();
const authoritativeTranscribe = createGoogleSpeechV2Transcriber({
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
  location: process.env.GOOGLE_SPEECH_LOCATION ?? "global",
  recognizer: process.env.GOOGLE_SPEECH_RECOGNIZER ?? "_",
  model: process.env.GOOGLE_SPEECH_MODEL || undefined,
  languageCodes: languageCodes(process.env.GOOGLE_SPEECH_LANGUAGE_CODES),
  accessTokenProvider,
});
const callerVadConfig = Object.freeze({
  startRms: positiveNumber(process.env.MEDIA_EDGE_VAD_START_RMS, "MEDIA_EDGE_VAD_START_RMS"),
  stopRms: positiveNumber(process.env.MEDIA_EDGE_VAD_STOP_RMS, "MEDIA_EDGE_VAD_STOP_RMS", { allowZero: true }),
  minSpeechMs: positiveNumber(process.env.MEDIA_EDGE_VAD_MIN_SPEECH_MS, "MEDIA_EDGE_VAD_MIN_SPEECH_MS"),
  minSilenceMs: positiveNumber(process.env.MEDIA_EDGE_VAD_MIN_SILENCE_MS, "MEDIA_EDGE_VAD_MIN_SILENCE_MS"),
});
if (callerVadConfig.startRms > 1 || callerVadConfig.stopRms > callerVadConfig.startRms) throw new Error("Media edge VAD RMS configuration is invalid");

const runtime = createGeminiMediaEdgeRuntime({ geminiApiKey: process.env.GEMINI_API_KEY, verifyCredential, consumeCredentialOnce: (credentialId, notAfterEpochMs, nowEpochMs) => credentialConsumer.consume(credentialId, notAfterEpochMs, nowEpochMs), consumeBootstrapForClaims: (claims, nowEpochMs) => bootstrapRegistry.consumeForClaims(claims, nowEpochMs), bindControlSession: (claims, sink) => controlRegistry.bindCommandSink(claims, sink), emitControlEvent: (claims, event) => controlRegistry.emit(claims, event), authoritativeTranscribe, callerVadConfig, model: process.env.GEMINI_LIVE_MODEL, maxBufferedBytes: process.env.MEDIA_EDGE_MAX_BUFFERED_BYTES ? Number(process.env.MEDIA_EDGE_MAX_BUFFERED_BYTES) : undefined });
const controlWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });
controlWss.on("connection", (socket, request) => { const url = new URL(request.url, "http://localhost"); const claims = { tenantId: required(url.searchParams.get("tenant_id"), "control tenant_id"), callControlId: required(url.searchParams.get("call_control_id"), "control call_control_id") }; let attachment; try { attachment = controlRegistry.attach(claims, (event) => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); }); } catch { socket.close(1008, "control session already attached"); return; } socket.on("message", (raw) => { try { controlRegistry.command(claims, JSON.parse(raw.toString("utf8"))); } catch { socket.close(1008, "invalid control command"); } }); socket.on("close", attachment.detach); socket.on("error", attachment.detach); });

const server = http.createServer(async (request, response) => {
  if (request.url === "/healthz" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ ok: true, service: "gemini-media-edge", activeSessions: runtime.activeSessions(), controlSessions: controlRegistry.size() })); return; }
  if (request.url === "/internal/bootstrap" && request.method === "POST") { if (!controlAuthorization(request, controlPlaneToken)) { response.writeHead(401, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ ok: false, error: "unauthorized" })); return; } try { const bootstrap = bootstrapRegistry.register(await readJsonBody(request), Date.now()); response.writeHead(201, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ ok: true, credentialId: bootstrap.credentialId })); } catch { response.writeHead(400, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ ok: false, error: "invalid_bootstrap" })); } return; }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); response.end("not found");
});
server.on("upgrade", (request, socket, head) => { const url = new URL(request.url, "http://localhost"); if (url.pathname === "/internal/control") { if (!controlAuthorization(request, controlPlaneToken)) { try { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); } catch {} socket.destroy(); return; } controlWss.handleUpgrade(request, socket, head, (client) => controlWss.emit("connection", client, request)); return; } void runtime.handleUpgrade(request, socket, head); });
server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ event: "gemini_media_edge_ready", port, callerInput: "DEFER_AUTHORITATIVE_STT" })));
async function shutdown() { server.close(); await runtime.close(); controlWss.close(); process.exit(0); } process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
