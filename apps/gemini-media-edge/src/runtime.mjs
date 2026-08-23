import { WebSocket, WebSocketServer } from "ws";
import { requireTelnyxStartForCredential } from "./credential.mjs";
import { buildGeminiInitialSetup, isGeminiSetupComplete } from "./bootstrap.mjs";
import { callerControlEnvelope, geminiControlEnvelope } from "./control-sideband.mjs";
import { AuthoritativeCallerInputOwner } from "./caller-input.mjs";
import { TelnyxPlaybackOwner } from "./playback.mjs";

const GEMINI_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const CONNECTING = 0;
const OPEN = 1;

function required(value, field) { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`); return value.trim(); }
function parseJson(data, source) { try { return JSON.parse(typeof data === "string" ? data : data.toString("utf8")); } catch { throw new Error(`Invalid ${source} JSON`); } }
function decodeBase64(value) { return Buffer.from(required(value, "audio payload"), "base64"); }
function encodeBase64(value) { return Buffer.from(value).toString("base64"); }
function bearerCredential(request) { const authorization = request.headers.authorization; if (typeof authorization !== "string") throw new Error("missing authorization"); const match = /^Bearer\s+(.+)$/i.exec(authorization.trim()); if (!match?.[1]?.trim()) throw new Error("missing bearer credential"); return match[1].trim(); }

export function swapPcm16Endianness(bytes) { if (bytes.length % 2 !== 0) throw new Error("PCM16 payload must contain complete 16-bit samples"); const output = Buffer.allocUnsafe(bytes.length); for (let i = 0; i < bytes.length; i += 2) { output[i] = bytes[i + 1]; output[i + 1] = bytes[i]; } return output; }
export class Pcm16Resampler24To16 { constructor() { this.pending = null; this.phase = 0; } reset() { this.pending = null; this.phase = 0; } push(bytes) { if (bytes.length % 2 !== 0) throw new Error("Gemini PCM16 output must contain complete samples"); const source = []; if (this.pending !== null) source.push(this.pending); for (let i = 0; i < bytes.length; i += 2) source.push(bytes.readInt16LE(i)); if (source.length < 2) { this.pending = source[0] ?? null; return Buffer.alloc(0); } const out = []; let position = this.phase; while (position + 1 < source.length) { const left = Math.floor(position); const fraction = position - left; const sample = Math.round(source[left] + (source[left + 1] - source[left]) * fraction); out.push(Math.max(-32768, Math.min(32767, sample))); position += 1.5; } const consumed = Math.floor(position); this.phase = position - consumed; this.pending = source[source.length - 1]; const result = Buffer.allocUnsafe(out.length * 2); out.forEach((sample, index) => result.writeInt16LE(sample, index * 2)); return result; } }

function geminiAudioPayloads(message) { const parts = message?.serverContent?.modelTurn?.parts ?? message?.server_content?.model_turn?.parts ?? []; const result = []; for (const part of parts) { const inline = part?.inlineData ?? part?.inline_data; const data = inline?.data; const mime = inline?.mimeType ?? inline?.mime_type; if (typeof data === "string" && typeof mime === "string" && /^audio\/pcm(?:;|$)/i.test(mime)) result.push(data); } return result; }
function safeSend(socket, message) { if (socket.readyState !== OPEN) throw new Error("Media edge socket is not open"); socket.send(typeof message === "string" || Buffer.isBuffer(message) ? message : JSON.stringify(message)); }

export class BoundPlaybackGate {
  constructor(maxBufferedBytes = 1_048_576) { this.maxBufferedBytes = maxBufferedBytes; this.pending = []; this.pendingBytes = 0; this.binding = null; this.owner = new TelnyxPlaybackOwner(); }
  queue(pcm) { if (!Buffer.isBuffer(pcm) || pcm.length === 0) return; this.pending.push(Buffer.from(pcm)); this.pendingBytes += pcm.length; if (this.pendingBytes > this.maxBufferedBytes) throw new Error("Gemini playback binding buffer limit exceeded"); }
  bind(responseId) { const id = required(responseId, "Gemini playback binding response id"); if (this.binding && this.binding !== id) throw new Error(`Gemini playback binding already owned by ${this.binding}`); this.binding = id; this.owner.bindResponse(id); return this.flush(); }
  flush() { if (!this.binding) return Object.freeze([]); const responseId = this.binding; const chunks = this.pending.splice(0); this.pendingBytes = 0; return Object.freeze(chunks.map((pcm) => Object.freeze({ responseId, pcm }))); }
  noteQueued(responseId) { return this.owner.noteAudioQueued(responseId); }
  finish(responseId) { const id = required(responseId, "Gemini playback drain response id"); if (this.binding !== id) throw new Error(`Gemini playback drain identity mismatch: expected ${this.binding ?? "<none>"}`); const snapshot = this.owner.snapshot(); if (!snapshot.started) { this.owner.release(); this.binding = null; return null; } return this.owner.requestDrainMark(id); }
  requestClear(responseId) { const id = required(responseId, "Gemini playback clear response id"); if (this.binding !== id) throw new Error(`Gemini playback clear identity mismatch: expected ${this.binding ?? "<none>"}`); return this.owner.requestClearMark(id); }
  observeReturnedMark(name) { const event = this.owner.observeReturnedMark(name); if (!event) return null; this.binding = null; return Object.freeze({ ...event, kind: "NORMAL" }); }
  activeResponseId() { return this.owner.activeResponseId(); }
  snapshot() { return Object.freeze({ binding: this.binding, pendingChunks: this.pending.length, pendingBytes: this.pendingBytes, playback: this.owner.snapshot() }); }
}

export function commitDeferredCallerTurn(gemini, turn, assertBackpressure) {
  if (!turn || !Array.isArray(turn.mediaPayloads) || turn.mediaPayloads.length === 0) throw new Error("Gemini caller turn has no replayable audio");
  assertBackpressure(gemini, "Gemini Live"); safeSend(gemini, { realtimeInput: { activityStart: {} } });
  for (const payload of turn.mediaPayloads) {
    const pcm16le = swapPcm16Endianness(decodeBase64(payload));
    assertBackpressure(gemini, "Gemini Live"); safeSend(gemini, { realtimeInput: { audio: { data: encodeBase64(pcm16le), mimeType: "audio/pcm;rate=16000" } } });
  }
  assertBackpressure(gemini, "Gemini Live"); safeSend(gemini, { realtimeInput: { activityEnd: {} } });
}

export function createGeminiMediaEdgeRuntime(options) {
  const apiKey = required(options.geminiApiKey, "GEMINI_API_KEY");
  if (typeof options.verifyCredential !== "function") throw new Error("Gemini media edge credential verifier is required");
  if (typeof options.consumeCredentialOnce !== "function") throw new Error("Gemini media edge credential consumer is required");
  if (typeof options.consumeBootstrapForClaims !== "function") throw new Error("Gemini media edge bootstrap consumer is required");
  if (typeof options.authoritativeTranscribe !== "function") throw new Error("Gemini media edge authoritative transcriber is required");
  if (!options.callerVadConfig || typeof options.callerVadConfig !== "object") throw new Error("Gemini media edge caller VAD configuration is required");
  const model = required(options.model ?? "gemini-3.1-flash-live-preview", "GEMINI_LIVE_MODEL");
  const maxBufferedBytes = Number(options.maxBufferedBytes ?? 1_048_576);
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 65_536) throw new Error("MEDIA_EDGE_MAX_BUFFERED_BYTES is invalid");
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 }); const sessions = new Set(); const pendingAuthorizations = new WeakMap();
  function rejectUpgrade(socket, status = "401 Unauthorized") { try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch {} socket.destroy(); }
  async function handleUpgrade(request, socket, head) { let claims; try { claims = await options.verifyCredential(bearerCredential(request), Date.now()); } catch { return rejectUpgrade(socket); } if (!claims || claims.provider !== "GEMINI") return rejectUpgrade(socket); wss.handleUpgrade(request, socket, head, (client) => { pendingAuthorizations.set(client, claims); wss.emit("connection", client, request); }); }

  wss.on("connection", (telnyx) => {
    const claims = pendingAuthorizations.get(telnyx); pendingAuthorizations.delete(telnyx); if (!claims) { try { telnyx.close(); } catch {} return; }
    const state = { telnyx, gemini: null, claims, bootstrap: null, controlAttachment: null, authorized: false, started: false, setupSent: false, setupComplete: false, streamId: null, nextChunk: 1, buffered: new Map(), resampler: new Pcm16Resampler24To16(), playback: new BoundPlaybackGate(maxBufferedBytes), callerInput: new AuthoritativeCallerInputOwner(options.authoritativeTranscribe, options.callerVadConfig, options.callerInputOptions), closed: false, telnyxChain: Promise.resolve() }; sessions.add(state);
    const closeBoth = () => { if (state.closed) return; state.closed = true; state.buffered.clear(); try { state.controlAttachment?.detach?.(); } catch {} state.controlAttachment = null; sessions.delete(state); try { if (telnyx.readyState === OPEN || telnyx.readyState === CONNECTING) telnyx.close(); } catch {} try { if (state.gemini?.readyState === OPEN || state.gemini?.readyState === CONNECTING) state.gemini.close(); } catch {} };
    const assertBackpressure = (socket, label) => { if (socket.bufferedAmount > maxBufferedBytes) throw new Error(`${label} backpressure limit exceeded`); };
    const emitPlaybackChunks = (chunks) => { for (const chunk of chunks) { assertBackpressure(telnyx, "Telnyx"); safeSend(telnyx, { event: "media", media: { payload: encodeBase64(swapPcm16Endianness(chunk.pcm)) } }); const noted = state.playback.noteQueued(chunk.responseId); if (noted.first) options.emitControlEvent?.(state.claims, { type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: chunk.responseId } }); } };
    const submitControlCommand = (command) => {
      if (!state.setupComplete || state.gemini?.readyState !== OPEN) throw new Error("Gemini Live control command requires setupComplete");
      if (command.type === "TOOL_RESULT") { assertBackpressure(state.gemini, "Gemini Live"); safeSend(state.gemini, { toolResponse: { functionResponses: [{ id: command.callId, name: command.toolName, response: { result: command.output } }] } }); return; }
      if (command.type === "PLAYBACK_BINDING") { emitPlaybackChunks(state.playback.bind(command.responseId)); return; }
      if (command.type === "PLAYBACK_DRAIN") { const mark = state.playback.finish(command.responseId); if (mark) { assertBackpressure(telnyx, "Telnyx"); safeSend(telnyx, { event: "mark", mark: { name: mark } }); } return; }
      if (command.type === "CALLER_TURN_DECISION") {
        if (command.decision === "IGNORE") { state.callerInput.resolve(command.itemId, "IGNORE"); return; }
        if (command.decision === "NORMAL") {
          if (state.playback.activeResponseId()) throw new Error("Gemini normal caller turn requires idle playback");
          const turn = state.callerInput.resolve(command.itemId, "NORMAL");
          // A candidate may have begun while an older playback was active and be
          // downgraded to NORMAL after that exact playback fully drained. The
          // authenticated control plane owns that temporal decision; only current
          // physical playback must be idle here.
          commitDeferredCallerTurn(state.gemini, turn, assertBackpressure);
          return;
        }
        if (command.decision === "INTERRUPT") {
          const responseId = required(command.responseId, "Gemini interruption response id");
          if (state.playback.activeResponseId() !== responseId) throw new Error(`Gemini interruption playback identity mismatch: expected ${state.playback.activeResponseId() ?? "<none>"}`);
          const turn = state.callerInput.resolve(command.itemId, "INTERRUPT");
          if (turn.playbackResponseIdAtStart !== responseId) throw new Error(`Gemini interruption caller identity mismatch: expected ${turn.playbackResponseIdAtStart ?? "<none>"}`);
          // Preserve the proven effect order: commit authorized activity to Gemini
          // first. Only after all provider sends succeed may Telnyx playout clear.
          commitDeferredCallerTurn(state.gemini, turn, assertBackpressure);
          assertBackpressure(telnyx, "Telnyx"); safeSend(telnyx, { event: "clear" });
          const clearMark = state.playback.requestClear(responseId);
          assertBackpressure(telnyx, "Telnyx"); safeSend(telnyx, { event: "mark", mark: { name: clearMark } });
          return;
        }
        throw new Error("Gemini caller turn decision is unsupported");
      }
      throw new Error("Gemini Live control command is unsupported");
    };
    const openGemini = (bootstrap) => { if (state.gemini) throw new Error("Gemini Live connection is one-shot"); state.bootstrap = bootstrap; state.controlAttachment = options.bindControlSession?.(state.claims, submitControlCommand) ?? null; const geminiUrl = new URL(GEMINI_ENDPOINT); geminiUrl.searchParams.set("key", apiKey); const gemini = new WebSocket(geminiUrl, { perMessageDeflate: false }); state.gemini = gemini;
      gemini.on("open", () => { try { if (state.setupSent) throw new Error("Gemini Live setup is one-shot"); safeSend(gemini, buildGeminiInitialSetup(bootstrap, model)); state.setupSent = true; } catch { closeBoth(); } });
      gemini.on("message", (raw) => { try { const message = parseJson(raw, "Gemini Live"); const controlEnvelope = geminiControlEnvelope(message); if (isGeminiSetupComplete(message)) { if (!state.setupSent || state.setupComplete) throw new Error("Gemini Live setupComplete is out of order"); state.setupComplete = true; options.emitControlEvent?.(state.claims, controlEnvelope); return; } if (!state.setupComplete) throw new Error("Gemini Live message arrived before setupComplete"); const delivered = options.emitControlEvent?.(state.claims, controlEnvelope); const audioPayloads = geminiAudioPayloads(message); if (audioPayloads.length > 0 && delivered !== true && !state.playback.activeResponseId()) throw new Error("Gemini output audio requires active control sideband"); for (const payload of audioPayloads) { const pcm16le16k = state.resampler.push(decodeBase64(payload)); if (pcm16le16k.length === 0) continue; state.playback.queue(pcm16le16k); } emitPlaybackChunks(state.playback.flush()); } catch { closeBoth(); } }); gemini.on("error", closeBoth); gemini.on("close", closeBoth); };
    async function observeTelnyx(raw) { const message = parseJson(raw, "Telnyx media"); const event = message?.event; if (event === "connected") return; if (event === "start") { if (state.started) throw new Error("Telnyx media start is one-shot"); const verifiedStart = requireTelnyxStartForCredential(state.claims, message); const consumed = await options.consumeCredentialOnce(state.claims.credentialId, state.claims.notAfterEpochMs, Date.now()); if (consumed !== true) throw new Error("Gemini media edge credential already consumed"); const bootstrap = await options.consumeBootstrapForClaims(state.claims, Date.now()); state.streamId = verifiedStart.streamId; state.authorized = true; state.started = true; openGemini(bootstrap); return; } if (!state.authorized || !state.started) throw new Error("Telnyx media received before authorized start"); if (typeof message.stream_id === "string" && message.stream_id.trim() !== state.streamId) throw new Error("Telnyx media stream identity changed"); if (event === "stop") return closeBoth(); if (event === "mark") { const playbackEvent = state.playback.observeReturnedMark(required(message?.mark?.name, "Telnyx playback mark name")); if (playbackEvent) options.emitControlEvent?.(state.claims, { type: "PLAYBACK_EVENT", event: playbackEvent }); return; } if (event !== "media" || message?.media?.track !== "inbound") return; const chunk = Number(message.media.chunk); if (!Number.isSafeInteger(chunk) || chunk < 1) throw new Error("Invalid Telnyx media chunk"); const payload = required(message.media.payload, "Telnyx media payload"); if (chunk < state.nextChunk) return; if (!state.buffered.has(chunk)) state.buffered.set(chunk, payload); if (state.buffered.size > 64) throw new Error("Telnyx media reorder window exceeded"); while (state.buffered.has(state.nextChunk)) { const ordered = state.buffered.get(state.nextChunk); state.buffered.delete(state.nextChunk); state.nextChunk += 1; const observation = await state.callerInput.observe(ordered, state.playback.activeResponseId()); for (const callerEvent of observation.events) { if (options.emitControlEvent?.(state.claims, callerControlEnvelope(callerEvent)) !== true) throw new Error("Gemini caller evidence requires active control sideband"); } } }
    telnyx.on("message", (raw) => { state.telnyxChain = state.telnyxChain.then(() => observeTelnyx(raw)).catch(() => closeBoth()); }); telnyx.on("error", closeBoth); telnyx.on("close", closeBoth);
  });
  return Object.freeze({ wss, handleUpgrade, activeSessions: () => sessions.size, async close() { for (const session of [...sessions]) { try { session.telnyx.close(); session.gemini?.close(); } catch {} } await new Promise((resolve) => wss.close(() => resolve())); } });
}
