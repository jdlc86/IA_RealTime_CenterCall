import http from "node:http";
import process from "node:process";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  InMemoryOneShotCredentialConsumer,
  createHmacCredentialVerifier,
  requireTelnyxStartForCredential,
} from "./credential.mjs";
import { InMemoryFastBootstrapRegistry } from "./fast-bootstrap.mjs";
import { InMemoryDiagnosticJournal } from "./diagnostic-journal.mjs";
import { createFastDiagnosticFlusher } from "./fast-diagnostic-flush.mjs";
import { FastGeminiRealtimeSession } from "./fast-runtime.mjs";
import { createFastTransferControlClient } from "./fast-transfer-control.mjs";
import { createFastTemporalControlClient } from "./fast-temporal-control.mjs";

const MEDIA_PATH = "/telnyx/gemini";
const TELNYX_START_TIMEOUT_MS = 5_000;
export const DEFAULT_FAST_DIAGNOSTIC_SINK_URL = "https://ia-realtime-centercall-gemini-fast.julopezcardona.workers.dev/internal/diagnostics-ingest";
const FAST_DIAGNOSTIC_STAGES = new Set([
  "FAST_TELNYX_CONNECTED",
  "FAST_TELNYX_START_AUTHORIZED",
  "FAST_SESSION_STARTED",
  "FAST_MEDIA_AUTHORIZED",
  "GEMINI_SETUP_SENT",
  "GEMINI_SETUP_COMPLETE",
  "FAST_FIRST_CALLER_MEDIA",
  "FAST_FIRST_GEMINI_AUDIO_TO_TELNYX",
  "BARGE_IN_CLEAR_SENT",
  "GEMINI_TURN_COMPLETE",
  "TOOL_RESULT_SENT",
  "HUMAN_HANDOFF_AUTHORIZATION_BLOCKED",
  "HUMAN_HANDOFF_ACCEPTED",
  "HUMAN_HANDOFF_TRANSFER_START_RESULT",
  "GEMINI_GO_AWAY",
  "FAST_SESSION_CLOSED",
]);

function required(value, field, max = 64_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /\u0000/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function optionalPositiveMetric(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
  return value;
}

function canonicalProviderReadiness(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Fast Gemini provider readiness is invalid");
  return Object.freeze({
    setupMs: optionalPositiveMetric(value.setupMs, "Fast Gemini provider setupMs"),
    firstAudioMs: optionalPositiveMetric(value.firstAudioMs, "Fast Gemini provider firstAudioMs"),
  });
}

function secureTokenEqual(actual, expected) {
  const left = Buffer.from(actual ?? "", "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function controlAuthorized(request, expected) {
  const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization.trim() : "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return Boolean(match && secureTokenEqual(match[1], expected));
}

async function readJsonBody(request, maxBytes = 262_144) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Fast Gemini request body exceeds limit");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Fast Gemini request body is invalid JSON"); }
}

function streamingCredential(request) {
  return required(request.headers["x-telnyx-streaming-auth-token"], "Telnyx streaming auth token", 16_384);
}

function edgeUrlForUpgrade(request) {
  const host = required(request.headers.host, "Fast Gemini media request host", 512);
  if (/[/\\\s,@]/.test(host)) throw new Error("Fast Gemini media request host is invalid");
  return new URL(`wss://${host}${MEDIA_PATH}`).toString();
}

function writeJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function parseTelnyxHandshakeMessage(raw) {
  try { return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")); }
  catch { throw new Error("Telnyx handshake JSON is invalid"); }
}

function safeFastDiagnostic(event) {
  if (!event || typeof event !== "object" || typeof event.stage !== "string") return null;
  if (FAST_DIAGNOSTIC_STAGES.has(event.stage)) return event;
  return null;
}

export function resolveFastDiagnosticSinkUrl(env = process.env) {
  const configured = typeof env.FAST_DIAGNOSTIC_SINK_URL === "string" ? env.FAST_DIAGNOSTIC_SINK_URL.trim() : "";
  return configured || DEFAULT_FAST_DIAGNOSTIC_SINK_URL;
}

export function resolveFastTransferControlUrl(env = process.env) {
  const configured = typeof env.FAST_CONTROL_PLANE_URL === "string" ? env.FAST_CONTROL_PLANE_URL.trim() : "";
  if (configured) return configured;
  return new URL(resolveFastDiagnosticSinkUrl(env)).origin;
}

export function createFastGeminiMediaServer(options = {}) {
  const geminiApiKey = required(options.geminiApiKey, "GEMINI_API_KEY", 8_192);
  const model = options.model ?? "gemini-3.1-flash-live-preview";
  const controlToken = required(options.controlToken, "MEDIA_EDGE_CONTROL_PLANE_TOKEN", 8_192);
  if (Buffer.byteLength(controlToken, "utf8") < 32) throw new Error("MEDIA_EDGE_CONTROL_PLANE_TOKEN must be at least 32 bytes");
  const verifyCredential = options.verifyCredential;
  if (typeof verifyCredential !== "function") throw new Error("Fast Gemini credential verifier is required");
  const credentialConsumer = options.credentialConsumer ?? new InMemoryOneShotCredentialConsumer();
  const bootstrapRegistry = options.bootstrapRegistry ?? new InMemoryFastBootstrapRegistry();
  const diagnosticJournal = options.diagnosticJournal ?? new InMemoryDiagnosticJournal({ maxEventsPerCall: 64 });
  const flushDiagnostics = typeof options.flushDiagnostics === "function" ? options.flushDiagnostics : null;
  const toolHandlers = options.toolHandlers ?? {};
  const authorizeTransfer = typeof options.authorizeTransfer === "function" ? options.authorizeTransfer : null;
  const startTransfer = typeof options.startTransfer === "function" ? options.startTransfer : null;
  const observe = typeof options.observe === "function" ? options.observe : () => {};
  const providerReadiness = canonicalProviderReadiness(options.providerReadiness);
  const sessions = new Set();

  function recordDiagnostic(event) {
    const selected = safeFastDiagnostic(event);
    if (!selected) return null;
    try {
      const normalized = { ...selected };
      if (Number.isSafeInteger(selected.sinceLastCallerMediaMicros)) normalized.observedMs = Math.round(selected.sinceLastCallerMediaMicros / 1_000);
      return diagnosticJournal.record(normalized);
    } catch {
      return null;
    }
  }

  function flushCallDiagnostics(callControlId) {
    if (!flushDiagnostics) return;
    let events;
    try { events = diagnosticJournal.read(callControlId); }
    catch { return; }
    if (!events.length) return;
    queueMicrotask(() => {
      Promise.resolve(flushDiagnostics(events)).catch(() => {});
    });
  }

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });
  wss.on("connection", (socket, request, claims) => {
    let claimed = false;
    let connectedSeen = false;
    let timer = null;
    const cleanupHandshake = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      socket.off("message", onHandshakeMessage);
    };
    const fail = (reason) => {
      cleanupHandshake();
      try { socket.close(1008, reason.slice(0, 120)); } catch {}
    };
    const startSession = (start) => {
      requireTelnyxStartForCredential(claims, start);
      const consumed = credentialConsumer.consume(claims.credentialId, claims.notAfterEpochMs, Date.now());
      if (consumed !== true) throw new Error("Fast Gemini media credential already consumed");
      const bootstrap = bootstrapRegistry.consumeForClaims(claims, Date.now());
      cleanupHandshake();
      recordDiagnostic({
        stage: "FAST_TELNYX_START_AUTHORIZED",
        tenantId: claims.tenantId,
        callControlId: claims.callControlId,
      });
      let session;
      let firstCallerMediaObserved = false;
      const sessionObserve = (event) => {
        try { observe(event); } catch {}
        if (event?.stage === "CALLER_CHUNK_FORWARDED" && !firstCallerMediaObserved) {
          firstCallerMediaObserved = true;
          recordDiagnostic({
            stage: "FAST_FIRST_CALLER_MEDIA",
            tenantId: event.tenantId,
            callControlId: event.callControlId,
          });
        } else if (event?.stage === "FIRST_GEMINI_AUDIO_TO_TELNYX") {
          recordDiagnostic({
            ...event,
            stage: "FAST_FIRST_GEMINI_AUDIO_TO_TELNYX",
            observedMs: Number.isSafeInteger(event.sinceLastCallerMediaMicros)
              ? Math.round(event.sinceLastCallerMediaMicros / 1_000)
              : undefined,
          });
        } else {
          recordDiagnostic(event);
        }
        if (event?.stage === "FAST_SESSION_CLOSED" && session) {
          sessions.delete(session);
          flushCallDiagnostics(event.callControlId);
        }
      };
      session = new FastGeminiRealtimeSession({
        telnyxSocket: socket,
        bootstrap,
        geminiApiKey,
        model,
        toolHandlers,
        authorizeTransfer,
        startTransfer,
        observe: sessionObserve,
        ...(options.createGeminiSocket ? { createGeminiSocket: options.createGeminiSocket } : {}),
        ...(options.maxBufferedBytes ? { maxBufferedBytes: options.maxBufferedBytes } : {}),
      }).start();
      sessions.add(session);
      sessionObserve({
        stage: "FAST_MEDIA_AUTHORIZED",
        tenantId: claims.tenantId,
        callControlId: claims.callControlId,
      });
    };
    const onHandshakeMessage = (raw) => {
      if (claimed) return fail("duplicate Telnyx start");
      try {
        const message = parseTelnyxHandshakeMessage(raw);
        if (message?.event === "connected") {
          if (connectedSeen) return fail("duplicate Telnyx connected");
          connectedSeen = true;
          recordDiagnostic({
            stage: "FAST_TELNYX_CONNECTED",
            tenantId: claims.tenantId,
            callControlId: claims.callControlId,
          });
          return;
        }
        if (message?.event !== "start") throw new Error("Telnyx start expected after connected");
        claimed = true;
        startSession(message);
      } catch {
        fail("invalid or unauthorized Telnyx start");
      }
    };
    socket.on("message", onHandshakeMessage);
    timer = setTimeout(() => fail("Telnyx start timeout"), TELNYX_START_TIMEOUT_MS);
    timer.unref?.();
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/ready" && request.method === "GET") {
      writeJson(response, 200, {
        ok: true,
        service: "gemini-media-edge-fast",
        model,
        revision: options.revision ?? null,
        activeSessions: sessions.size,
        registeredBootstraps: bootstrapRegistry.size(),
        diagnosticCalls: diagnosticJournal.size(),
        providerReadiness,
      });
      return;
    }
    if (url.pathname === "/internal/diagnostics" && request.method === "GET") {
      if (!controlAuthorized(request, controlToken)) {
        writeJson(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      try {
        const callControlId = required(url.searchParams.get("call_control_id"), "diagnostic call_control_id", 512);
        writeJson(response, 200, { ok: true, events: diagnosticJournal.read(callControlId) });
      } catch {
        writeJson(response, 400, { ok: false, error: "invalid_diagnostic_request" });
      }
      return;
    }
    if (url.pathname === "/internal/bootstrap" && request.method === "POST") {
      if (!controlAuthorized(request, controlToken)) {
        writeJson(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      try {
        const bootstrap = bootstrapRegistry.register(await readJsonBody(request), Date.now());
        writeJson(response, 201, { ok: true, credentialId: bootstrap.credentialId });
      } catch {
        writeJson(response, 400, { ok: false, error: "invalid_bootstrap" });
      }
      return;
    }
    writeJson(response, 404, { ok: false, error: "not_found" });
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== MEDIA_PATH) {
      socket.destroy();
      return;
    }
    void (async () => {
      try {
        const expectedEdgeUrl = edgeUrlForUpgrade(request);
        const claims = await verifyCredential(streamingCredential(request), Date.now(), expectedEdgeUrl);
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, claims));
      } catch {
        try { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); } catch {}
        socket.destroy();
      }
    })();
  });

  return Object.freeze({
    server,
    wss,
    mediaPath: MEDIA_PATH,
    activeSessions: () => sessions.size,
    registeredBootstraps: () => bootstrapRegistry.size(),
    diagnosticCalls: () => diagnosticJournal.size(),
    providerReadiness,
    async close() {
      for (const session of [...sessions]) session.close("SERVER_SHUTDOWN");
      await new Promise((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  });
}

export function createFastGeminiMediaServerFromEnv(env = process.env, options = {}) {
  if (env.MEDIA_EDGE_SINGLE_INSTANCE !== "true") {
    throw new Error("MEDIA_EDGE_SINGLE_INSTANCE=true is required while fast bootstrap state is in-memory");
  }
  const credentialSecret = required(env.MEDIA_EDGE_CREDENTIAL_HMAC_SECRET, "MEDIA_EDGE_CREDENTIAL_HMAC_SECRET", 8_192);
  const controlToken = required(env.MEDIA_EDGE_CONTROL_PLANE_TOKEN, "MEDIA_EDGE_CONTROL_PLANE_TOKEN", 8_192);
  const flushDiagnostics = options.flushDiagnostics ?? createFastDiagnosticFlusher({
    sinkUrl: resolveFastDiagnosticSinkUrl(env),
    controlToken,
  });
  const controlPlaneUrl = resolveFastTransferControlUrl(env);
  const transferControl = options.transferControl ?? createFastTransferControlClient({
    baseUrl: controlPlaneUrl,
    controlToken,
    ...(options.transferControlFetch ? { fetcher: options.transferControlFetch } : {}),
  });
  const temporalControl = options.temporalControl ?? createFastTemporalControlClient({
    baseUrl: controlPlaneUrl,
    controlToken,
    ...(options.temporalControlFetch ? { fetcher: options.temporalControlFetch } : {}),
  });
  const toolHandlers = Object.freeze({
    ...(options.toolHandlers ?? {}),
    get_authoritative_datetime: (_call, context) => temporalControl.getAuthoritativeDateTime({
      tenantId: context.tenantId,
      callControlId: context.callControlId,
    }),
  });
  return createFastGeminiMediaServer({
    geminiApiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview",
    controlToken,
    verifyCredential: (rawCredential, nowEpochMs, expectedEdgeUrl) =>
      createHmacCredentialVerifier(credentialSecret, expectedEdgeUrl)(rawCredential, nowEpochMs),
    revision: env.K_REVISION ?? null,
    maxBufferedBytes: env.MEDIA_EDGE_MAX_BUFFERED_BYTES ? Number(env.MEDIA_EDGE_MAX_BUFFERED_BYTES) : undefined,
    providerReadiness: options.providerReadiness ?? null,
    flushDiagnostics,
    toolHandlers,
    authorizeTransfer: transferControl.authorizeTransfer,
    startTransfer: transferControl.startTransfer,
  });
}

const isEntrypoint = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");
  const runtime = createFastGeminiMediaServerFromEnv();
  runtime.server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({
      event: "gemini_fast_media_ready",
      port,
      model: process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview",
      mediaPath: runtime.mediaPath,
    }));
  });
  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
