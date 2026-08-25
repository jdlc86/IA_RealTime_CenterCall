import { WebSocket, WebSocketServer } from "ws";
import { requireTelnyxStartForCredential } from "./credential.mjs";
import { buildGeminiInitialSetup, isGeminiSetupComplete } from "./bootstrap.mjs";
import { callerControlEnvelope, geminiControlEnvelope, governedControlEnvelope, inputDetectionControlEnvelope } from "./control-sideband.mjs";
import { AuthoritativeCallerInputOwner } from "./caller-input.mjs";
import { TelnyxPlaybackOwner } from "./playback.mjs";
import { GeminiSemanticToolGate } from "./semantic-tool-gate.mjs";
import { prepareGovernedSpeechAudio } from "./governed-speech-audio.mjs";
import { GovernedSpeechPlaybackCoordinator } from "./governed-speech-playback-coordinator.mjs";

const GEMINI_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const CONNECTING = 0;
const OPEN = 1;

function required(value, field) { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`); return value.trim(); }
function parseJson(data, source) { try { return JSON.parse(typeof data === "string" ? data : data.toString("utf8")); } catch { throw new Error(`Invalid ${source} JSON`); } }
function decodeBase64(value) { return Buffer.from(required(value, "audio payload"), "base64"); }
function encodeBase64(value) { return Buffer.from(value).toString("base64"); }
export function telnyxStreamingCredential(request) {
  const credential = request?.headers?.["x-telnyx-streaming-auth-token"];
  if (typeof credential !== "string" || !credential.trim()) {
    throw new Error("missing Telnyx streaming auth token");
  }
  return credential.trim();
}
function playbackKind(value) { if (value == null || value === "NORMAL") return "NORMAL"; if (["GREETING", "RECOVERY", "TERMINAL", "PRESENCE", "HANDOFF"].includes(value)) return value; throw new Error("Gemini playback kind is unsupported"); }

export function classifyGovernedSpeechFailure(error) {
  const message = error instanceof Error ? error.message : "";
  if (/session (?:is no longer active|closed)/i.test(message)) return "SESSION_INACTIVE";
  if (/control sideband/i.test(message)) return "CONTROL_SIDEBAND_INACTIVE";
  if (/(?:socket is not open|backpressure limit exceeded)/i.test(message)) return "TELNYX_SOCKET_NOT_WRITABLE";
  if (/(?:identity mismatch|drain identity mismatch)/i.test(message)) return "PLAYBACK_IDENTITY_MISMATCH";
  if (/(?:requires idle Telnyx playback|already owns)/i.test(message)) return "PLAYBACK_NOT_IDLE";
  if (/(?:binding already owned|binding kind mismatch)/i.test(message)) return "PLAYBACK_BIND_FAILED";
  if (/(?:returned (?:an )?invalid|returned unsupported|invalid WAV|truncated WAV|incomplete WAV|invalid PCM16|unsupported WAV|unsupported audio container)/i.test(message)) {
    return "TTS_CONTRACT_INVALID";
  }
  if (/(?:Text-to-Speech|speech synthesizer|synthesis)/i.test(message)) return "TTS_FAILED";
  if (/playback start/i.test(message)) return "PLAYBACK_START_EVENT_FAILED";
  if (/drain mark/i.test(message)) return "PLAYBACK_DRAIN_MARK_FAILED";
  return "UNKNOWN_GOVERNED_SPEECH_FAILURE";
}

export function assertMediaEdgeSocketWritable(socket, label, maxBufferedBytes) {
  const name = required(label, "Media edge socket label");
  if (!socket || socket.readyState !== OPEN) throw new Error(`${name} socket is not open`);
  if (socket.bufferedAmount > maxBufferedBytes) throw new Error(`${name} backpressure limit exceeded`);
}

export function requirePcm16LittleEndian(bytes, source = "PCM16 payload") { const pcm = Buffer.from(bytes); if (pcm.length === 0 || pcm.length % 2 !== 0) throw new Error(`${source} must contain complete 16-bit little-endian samples`); return pcm; }
export class Pcm16Resampler24To16 { constructor() { this.pending = null; this.phase = 0; } reset() { this.pending = null; this.phase = 0; } push(bytes) { if (bytes.length % 2 !== 0) throw new Error("Gemini PCM16 output must contain complete samples"); const source = []; if (this.pending !== null) source.push(this.pending); for (let i = 0; i < bytes.length; i += 2) source.push(bytes.readInt16LE(i)); if (source.length < 2) { this.pending = source[0] ?? null; return Buffer.alloc(0); } const out = []; let position = this.phase; while (position + 1 < source.length) { const left = Math.floor(position); const fraction = position - left; const sample = Math.round(source[left] + (source[left + 1] - source[left]) * fraction); out.push(Math.max(-32768, Math.min(32767, sample))); position += 1.5; } const consumed = Math.floor(position); this.phase = position - consumed; this.pending = source[source.length - 1]; const result = Buffer.allocUnsafe(out.length * 2); out.forEach((sample, index) => result.writeInt16LE(sample, index * 2)); return result; } }

function geminiAudioPayloads(message) { const parts = message?.serverContent?.modelTurn?.parts ?? message?.server_content?.model_turn?.parts ?? []; const result = []; for (const part of parts) { const inline = part?.inlineData ?? part?.inline_data; const data = inline?.data; const mime = inline?.mimeType ?? inline?.mime_type; if (typeof data === "string" && typeof mime === "string" && /^audio\/pcm(?:;|$)/i.test(mime)) result.push(data); } return result; }
function safeSend(socket, message) { if (socket.readyState !== OPEN) throw new Error("Media edge socket is not open"); socket.send(typeof message === "string" || Buffer.isBuffer(message) ? message : JSON.stringify(message)); }

export class BoundPlaybackGate {
  constructor(maxBufferedBytes = 1_048_576) { this.maxBufferedBytes = maxBufferedBytes; this.pending = []; this.pendingBytes = 0; this.binding = null; this.bindingKind = null; this.owner = new TelnyxPlaybackOwner(); }
  queue(pcm) { if (!Buffer.isBuffer(pcm) || pcm.length === 0) return; this.pending.push(Buffer.from(pcm)); this.pendingBytes += pcm.length; if (this.pendingBytes > this.maxBufferedBytes) throw new Error("Gemini playback binding buffer limit exceeded"); }
  bind(responseId, kind = "NORMAL") { const id = required(responseId, "Gemini playback binding response id"); const normalizedKind = playbackKind(kind); if (this.binding && this.binding !== id) throw new Error(`Gemini playback binding already owned by ${this.binding}`); if (this.bindingKind && this.bindingKind !== normalizedKind) throw new Error(`Gemini playback binding kind mismatch: expected ${this.bindingKind}`); this.binding = id; this.bindingKind = normalizedKind; this.owner.bindResponse(id); return this.flush(); }
  flush() { if (!this.binding || !this.bindingKind) return Object.freeze([]); const responseId = this.binding; const kind = this.bindingKind; const chunks = this.pending.splice(0); this.pendingBytes = 0; return Object.freeze(chunks.map((pcm) => Object.freeze({ responseId, kind, pcm }))); }
  noteQueued(responseId) { return this.owner.noteAudioQueued(responseId); }
  finish(responseId) { const id = required(responseId, "Gemini playback drain response id"); if (this.binding !== id) throw new Error(`Gemini playback drain identity mismatch: expected ${this.binding ?? "<none>"}`); const snapshot = this.owner.snapshot(); if (!snapshot.started) { this.owner.release(); this.binding = null; this.bindingKind = null; return null; } return this.owner.requestDrainMark(id); }
  requestClear(responseId) { const id = required(responseId, "Gemini playback clear response id"); if (this.binding !== id) throw new Error(`Gemini playback clear identity mismatch: expected ${this.binding ?? "<none>"}`); return this.owner.requestClearMark(id); }
  observeReturnedMark(name) { const kind = this.bindingKind; const event = this.owner.observeReturnedMark(name); if (!event) return null; if (!kind) throw new Error("Gemini playback mark has no bound kind"); this.binding = null; this.bindingKind = null; return Object.freeze({ ...event, kind }); }
  activeResponseId() { return this.owner.activeResponseId(); }
  assertIdle() { if (this.binding || this.pendingBytes || this.owner.activeResponseId()) throw new Error("Gemini governed speech requires idle Telnyx playback"); }
  reset() { this.pending = []; this.pendingBytes = 0; this.binding = null; this.bindingKind = null; this.owner.release(); }
  snapshot() { return Object.freeze({ binding: this.binding, bindingKind: this.bindingKind, pendingChunks: this.pending.length, pendingBytes: this.pendingBytes, playback: this.owner.snapshot() }); }
}

export async function executeGovernedSpeechPlayback(options) {
  const command = options?.command;
  const responseId = required(command?.responseId, "Governed speech response id");
  const kind = playbackKind(command?.kind);
  const purpose = command?.purpose == null ? null : required(command.purpose, "Governed speech purpose");
  const coordinator = options?.coordinator;
  const playback = options?.playback;
  if (!coordinator || typeof coordinator.reserve !== "function") throw new Error("Governed speech coordinator is required");
  if (!playback || typeof playback.assertIdle !== "function" || typeof playback.reset !== "function") throw new Error("Governed speech playback owner is required");
  if (typeof options?.assertSessionActive !== "function") throw new Error("Governed speech session assertion is required");
  if (typeof options?.emitPlaybackChunks !== "function") throw new Error("Governed speech playback emitter is required");
  if (typeof options?.sendDrainMark !== "function") throw new Error("Governed speech drain sender is required");
  if (typeof options?.emitControlEvent !== "function") throw new Error("Governed speech lifecycle emitter is required");

  playback.assertIdle();
  coordinator.reserve(responseId);
  try {
    const prepared = await prepareGovernedSpeechAudio(options.synthesize, command);
    options.assertSessionActive();
    playback.assertIdle();
    playback.queue(prepared.pcm16le);
    const chunks = playback.bind(responseId, kind);
    coordinator.beginPlayback(responseId);
    let responseStarted = false;
    options.assertSessionActive();
    options.emitPlaybackChunks(chunks, () => {
      const delivered = options.emitControlEvent(governedControlEnvelope({
        type: "ASSISTANT_RESPONSE_STARTED",
        responseId,
        kind,
        ...(purpose ? { purpose } : {}),
      }));
      if (delivered !== true) throw new Error("Governed speech response start requires active control sideband");
      responseStarted = true;
    });
    if (!responseStarted) throw new Error("Governed speech produced no Telnyx playback start");
    const mark = playback.finish(responseId);
    if (!mark) throw new Error("Governed speech produced no correlated Telnyx drain mark");
    options.sendDrainMark(mark);
    return Object.freeze({ responseId, kind, ...(purpose ? { purpose } : {}) });
  } catch (error) {
    playback.reset();
    coordinator.reset();
    throw error;
  }
}

export function completeGovernedSpeechPlayback(options) {
  const context = options?.context;
  const event = options?.event;
  const responseId = required(context?.responseId, "Governed speech completion response id");
  const kind = playbackKind(context?.kind);
  if (event?.responseId !== responseId || event?.kind !== kind) throw new Error("Governed speech completion identity mismatch");
  if (options.coordinator.observePlaybackEvent(event) !== true) throw new Error("Governed speech completion has no active ownership");
  if (options.emitControlEvent({ type: "PLAYBACK_EVENT", event }) !== true) throw new Error("Governed speech playback completion requires active control sideband");
  if (options.emitControlEvent(governedControlEnvelope({ type: "ASSISTANT_RESPONSE_COMPLETED", responseId, kind, status: "completed" })) !== true) {
    throw new Error("Governed speech response completion requires active control sideband");
  }
}

export function requestCorrelatedPlaybackClear(options) {
  const responseId = required(options?.command?.responseId, "Gemini playback clear response id");
  const playback = options?.playback;
  if (!playback || typeof playback.activeResponseId !== "function" || typeof playback.requestClear !== "function") {
    throw new Error("Gemini playback clear owner is required");
  }
  if (typeof options?.sendClear !== "function" || typeof options?.sendMark !== "function") {
    throw new Error("Gemini playback clear transport is required");
  }
  const activeResponseId = playback.activeResponseId();
  if (activeResponseId !== responseId) {
    throw new Error(`Gemini playback clear identity mismatch: expected ${activeResponseId ?? "<none>"}`);
  }
  const mark = playback.requestClear(responseId);
  options.sendClear();
  options.sendMark(mark);
  return mark;
}

export function applyCallerInputControlCommand(command, owner, emitControlEvent) {
  if (!owner || typeof owner.clear !== "function" || typeof owner.suspend !== "function" || typeof owner.restore !== "function") {
    throw new Error("Gemini caller input control owner is required");
  }
  if (typeof emitControlEvent !== "function") throw new Error("Gemini input detection lifecycle emitter is required");
  if (command?.type === "CALLER_INPUT_CLEAR") { owner.clear(); return true; }
  if (command?.type === "INPUT_DETECTION_SUSPEND") {
    owner.suspend();
    emitControlEvent(inputDetectionControlEnvelope(false));
    return true;
  }
  if (command?.type === "INPUT_DETECTION_RESTORE") {
    owner.restore();
    emitControlEvent(inputDetectionControlEnvelope(true));
    return true;
  }
  return false;
}

export function commitDeferredCallerTurn(gemini, turn, assertBackpressure) {
  if (!turn || !Array.isArray(turn.mediaPayloads) || turn.mediaPayloads.length === 0) throw new Error("Gemini caller turn has no replayable audio");
  assertBackpressure(gemini, "Gemini Live"); safeSend(gemini, { realtimeInput: { activityStart: {} } });
  for (const payload of turn.mediaPayloads) {
    const pcm16le = requirePcm16LittleEndian(decodeBase64(payload), "Telnyx L16 payload");
    assertBackpressure(gemini, "Gemini Live"); safeSend(gemini, { realtimeInput: { audio: { data: encodeBase64(pcm16le), mimeType: "audio/pcm;rate=16000" } } });
  }
  assertBackpressure(gemini, "Gemini Live"); safeSend(gemini, { realtimeInput: { activityEnd: {} } });
}

export async function preselectAndCommitDeferredCallerTurn(options) {
  const gate = options?.semanticGate;
  const itemId = required(options?.itemId, "Gemini semantic preselection caller item id");
  if (!gate || typeof gate.preArm !== "function" || typeof gate.preselect !== "function") throw new Error("Gemini semantic preselection gate is required");
  if (typeof options?.semanticPreselect !== "function") throw new Error("Gemini semantic preselection function is required");
  if (typeof options?.commit !== "function") throw new Error("Gemini semantic preselection commit function is required");
  gate.preArm(itemId);
  const selection = await options.semanticPreselect({ itemId, transcript: required(options?.turn?.transcript, "Gemini semantic preselection transcript") });
  gate.preselect(itemId, selection);
  options.assertStillActive?.();
  options.commit();
  return selection;
}

export function createGeminiMediaEdgeRuntime(options) {
  const apiKey = required(options.geminiApiKey, "GEMINI_API_KEY");
  if (typeof options.verifyCredential !== "function") throw new Error("Gemini media edge credential verifier is required");
  if (typeof options.consumeCredentialOnce !== "function") throw new Error("Gemini media edge credential consumer is required");
  if (typeof options.consumeBootstrapForClaims !== "function") throw new Error("Gemini media edge bootstrap consumer is required");
  if (typeof options.authoritativeTranscribe !== "function") throw new Error("Gemini media edge authoritative transcriber is required");
  if (typeof options.synthesizeGovernedSpeech !== "function") throw new Error("Gemini media edge governed speech synthesizer is required");
  if (typeof options.isControlSessionActive !== "function") throw new Error("Gemini media edge control-session authority is required");
  if (typeof options.semanticPreselect !== "function") throw new Error("Gemini media edge semantic preselection authority is required");
  if (!options.callerVadConfig || typeof options.callerVadConfig !== "object") throw new Error("Gemini media edge caller VAD configuration is required");
  const model = required(options.model ?? "gemini-3.1-flash-live-preview", "GEMINI_LIVE_MODEL");
  const maxBufferedBytes = Number(options.maxBufferedBytes ?? 1_048_576);
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 65_536) throw new Error("MEDIA_EDGE_MAX_BUFFERED_BYTES is invalid");
  const createGeminiSocket = options.createGeminiSocket ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
  if (typeof createGeminiSocket !== "function") throw new Error("Gemini Live socket factory is required");
  const observeDiagnostic = typeof options.observeDiagnostic === "function" ? options.observeDiagnostic : () => {};
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 }); const sessions = new Set(); const pendingAuthorizations = new WeakMap();
  function rejectUpgrade(socket, status = "401 Unauthorized") { try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch {} socket.destroy(); }
  async function handleUpgrade(request, socket, head) { let claims; try { claims = await options.verifyCredential(telnyxStreamingCredential(request), Date.now()); } catch { return rejectUpgrade(socket); } if (!claims || claims.provider !== "GEMINI") return rejectUpgrade(socket); wss.handleUpgrade(request, socket, head, (client) => { pendingAuthorizations.set(client, claims); wss.emit("connection", client, request); }); }

  wss.on("connection", (telnyx) => {
    const claims = pendingAuthorizations.get(telnyx); pendingAuthorizations.delete(telnyx); if (!claims) { try { telnyx.close(); } catch {} return; }
    const state = { telnyx, gemini: null, claims, bootstrap: null, controlAttachment: null, authorized: false, started: false, setupSent: false, setupComplete: false, phase: "MEDIA_SOCKET_AUTHORIZED", streamId: null, nextChunk: 1, buffered: new Map(), resampler: new Pcm16Resampler24To16(), playback: new BoundPlaybackGate(maxBufferedBytes), governedPlayback: new GovernedSpeechPlaybackCoordinator(), governedContext: null, callerInput: new AuthoritativeCallerInputOwner(options.authoritativeTranscribe, options.callerVadConfig, options.callerInputOptions), lastVadDiagnosticSamples: 0, semanticGate: new GeminiSemanticToolGate(), closed: false, telnyxChain: Promise.resolve() }; sessions.add(state);
    const diagnose = (stage, details = {}) => { try { observeDiagnostic({ stage, tenantId: state.claims.tenantId, callControlId: state.claims.callControlId, ...details }); } catch {} };
    diagnose(state.phase);
    const closeBoth = (reason = "UNSPECIFIED", details = {}) => { if (state.closed) return; diagnose("MEDIA_SESSION_CLOSING", { phase: state.phase, reason, ...details }); state.closed = true; state.buffered.clear(); state.playback.reset(); state.governedPlayback.reset(); state.governedContext = null; try { state.controlAttachment?.detach?.(); } catch {} state.controlAttachment = null; sessions.delete(state); try { if (telnyx.readyState === OPEN || telnyx.readyState === CONNECTING) telnyx.close(); } catch {} try { if (state.gemini?.readyState === OPEN || state.gemini?.readyState === CONNECTING) state.gemini.close(); } catch {} };
    const assertBackpressure = (socket, label) => assertMediaEdgeSocketWritable(socket, label, maxBufferedBytes);
    const emitRequiredControlEvent = (event, error) => { if (options.emitControlEvent?.(state.claims, event) !== true) throw new Error(error); };
    const emitPlaybackChunks = (chunks, onFirstQueued = null) => { for (const chunk of chunks) { assertBackpressure(telnyx, "Telnyx"); const pcm16le = requirePcm16LittleEndian(chunk.pcm, "Telnyx playback PCM16"); safeSend(telnyx, { event: "media", media: { payload: encodeBase64(pcm16le) } }); const noted = state.playback.noteQueued(chunk.responseId); if (noted.first) { onFirstQueued?.(); const delivered = options.emitControlEvent?.(state.claims, { type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", kind: chunk.kind, responseId: chunk.responseId } }); if (onFirstQueued && delivered !== true) throw new Error("Governed speech playback start requires active control sideband"); } } };
    const commitPreselectedTurn = (command, turn) => preselectAndCommitDeferredCallerTurn({
      semanticGate: state.semanticGate,
      itemId: command.itemId,
      turn,
      semanticPreselect: ({ itemId, transcript }) => options.semanticPreselect({ claims: state.claims, bootstrap: state.bootstrap, itemId, transcript }),
      assertStillActive: () => {
        if (state.closed || options.isControlSessionActive(state.claims) !== true) throw new Error("Gemini semantic preselection session is no longer active");
      },
      commit: () => commitDeferredCallerTurn(state.gemini, turn, assertBackpressure),
    }).then((selection) => {
      diagnose("SEMANTIC_PRESELECTION_COMPLETED", {
        itemId: command.itemId,
        selectedTool: selection.selectedTool,
        directModelOutputAllowed: selection.directModelOutputAllowed,
      });
      return selection;
    }).catch((error) => {
      closeBoth("SEMANTIC_PRESELECTION_FAILED");
      throw error;
    });
    const submitControlCommand = (command) => {
      if (!state.setupComplete || state.gemini?.readyState !== OPEN) throw new Error("Gemini Live control command requires setupComplete");
      if (command.type === "SEMANTIC_GATE_ARM") { state.semanticGate.confirmArm(); return; }
      if (command.type === "SEMANTIC_GATE_RELEASE") { state.semanticGate.release(); return; }
      if (applyCallerInputControlCommand(command, state.callerInput, (event) => emitRequiredControlEvent(event, "Input detection update requires active control sideband"))) return;
      if (command.type === "TOOL_RESULT") {
        if (state.semanticGate.snapshot().armed) state.semanticGate.rejectProvisionalSelection(command.callId, command.toolName);
        assertBackpressure(state.gemini, "Gemini Live"); safeSend(state.gemini, { toolResponse: { functionResponses: [{ id: command.callId, name: command.toolName, response: { result: command.output } }] } }); return;
      }
      if (command.type === "PLAYBACK_BINDING") { emitPlaybackChunks(state.playback.bind(command.responseId)); return; }
      if (command.type === "PLAYBACK_DRAIN") { const mark = state.playback.finish(command.responseId); if (mark) { assertBackpressure(telnyx, "Telnyx"); safeSend(telnyx, { event: "mark", mark: { name: mark } }); } return; }
      if (command.type === "PLAYBACK_CLEAR") {
        requestCorrelatedPlaybackClear({
          command,
          playback: state.playback,
          sendClear: () => { assertBackpressure(telnyx, "Telnyx"); safeSend(telnyx, { event: "clear" }); },
          sendMark: (mark) => { assertBackpressure(telnyx, "Telnyx"); safeSend(telnyx, { event: "mark", mark: { name: mark } }); },
        });
        return;
      }
      if (command.type === "GOVERNED_SPEECH") {
        return executeGovernedSpeechPlayback({
          command,
          synthesize: options.synthesizeGovernedSpeech,
          coordinator: state.governedPlayback,
          playback: state.playback,
          assertSessionActive: () => {
            if (state.closed || options.isControlSessionActive(state.claims) !== true) throw new Error("Governed speech session is no longer active");
          },
          emitPlaybackChunks,
          emitControlEvent: (event) => options.emitControlEvent?.(state.claims, event),
          sendDrainMark: (mark) => { assertBackpressure(telnyx, "Telnyx"); safeSend(telnyx, { event: "mark", mark: { name: mark } }); },
        }).then((context) => { state.governedContext = context; diagnose("GOVERNED_SPEECH_QUEUED", { kind: context.kind }); }).catch((error) => {
          const failureCategory = classifyGovernedSpeechFailure(error);
          diagnose("GOVERNED_SPEECH_FAILED", { severity: "error", errorCode: failureCategory, failureCategory });
          closeBoth("GOVERNED_SPEECH_FAILED", { failureCategory });
          throw error;
        });
      }
      if (command.type === "CALLER_TURN_DECISION") {
        if (command.decision === "IGNORE") { state.callerInput.resolve(command.itemId, "IGNORE"); return; }
        if (command.decision === "NORMAL") {
          if (state.playback.activeResponseId()) throw new Error("Gemini normal caller turn requires idle playback");
          const turn = state.callerInput.resolve(command.itemId, "NORMAL");
          // A candidate may have begun while an older playback was active and be
          // downgraded to NORMAL after that exact playback fully drained. The
          // authenticated control plane owns that temporal decision; only current
          // physical playback must be idle here. The semantic gate is pre-armed
          // synchronously, but audio stays deferred until isolated preselection.
          return commitPreselectedTurn(command, turn);
        }
        if (command.decision === "INTERRUPT") {
          const responseId = required(command.responseId, "Gemini interruption response id");
          if (state.playback.activeResponseId() !== responseId) throw new Error(`Gemini interruption playback identity mismatch: expected ${state.playback.activeResponseId() ?? "<none>"}`);
          const turn = state.callerInput.resolve(command.itemId, "INTERRUPT");
          if (turn.playbackResponseIdAtStart !== responseId) throw new Error(`Gemini interruption caller identity mismatch: expected ${turn.playbackResponseIdAtStart ?? "<none>"}`);
          // Preserve effect order: isolated semantic preselection and authorized
          // caller activity commit must both succeed before Telnyx playout clears.
          return commitPreselectedTurn(command, turn).then(() => {
            requestCorrelatedPlaybackClear({
              command: { type: "PLAYBACK_CLEAR", responseId },
              playback: state.playback,
              sendClear: () => { assertBackpressure(telnyx, "Telnyx"); safeSend(telnyx, { event: "clear" }); },
              sendMark: (mark) => { assertBackpressure(telnyx, "Telnyx"); safeSend(telnyx, { event: "mark", mark: { name: mark } }); },
            });
          });
        }
        throw new Error("Gemini caller turn decision is unsupported");
      }
      throw new Error("Gemini Live control command is unsupported");
    };
    const openGemini = (bootstrap) => { if (state.gemini) throw new Error("Gemini Live connection is one-shot"); state.bootstrap = bootstrap; state.phase = "GEMINI_CONNECTING"; diagnose(state.phase); const geminiUrl = new URL(GEMINI_ENDPOINT); geminiUrl.searchParams.set("key", apiKey); const gemini = createGeminiSocket(geminiUrl, { perMessageDeflate: false }); if (!gemini || typeof gemini.on !== "function" || typeof gemini.send !== "function" || typeof gemini.close !== "function") throw new Error("Gemini Live socket factory returned an invalid socket"); state.gemini = gemini;
      gemini.on("open", () => { try { state.phase = "GEMINI_SOCKET_OPEN"; diagnose(state.phase); if (state.setupSent) throw new Error("Gemini Live setup is one-shot"); safeSend(gemini, buildGeminiInitialSetup(bootstrap, model)); state.setupSent = true; state.phase = "GEMINI_SETUP_SENT"; diagnose(state.phase); } catch { closeBoth("GEMINI_SETUP_SEND_FAILED"); } });
      gemini.on("message", (raw) => { try { const message = parseJson(raw, "Gemini Live"); const controlEnvelope = geminiControlEnvelope(message); if (isGeminiSetupComplete(message)) { if (!state.setupSent || state.setupComplete) throw new Error("Gemini Live setupComplete is out of order"); state.setupComplete = true; state.phase = "GEMINI_SETUP_COMPLETE"; diagnose(state.phase); state.controlAttachment = options.bindControlSession?.(state.claims, submitControlCommand) ?? null; state.phase = "CONTROL_SINK_BOUND"; diagnose(state.phase); options.emitControlEvent?.(state.claims, controlEnvelope); return; } if (!state.setupComplete) { const providerErrorCode = message?.error?.code === undefined ? undefined : String(message.error.code); closeBoth("GEMINI_PRE_SETUP_MESSAGE", providerErrorCode ? { providerErrorCode } : {}); return; } const audioPayloads = geminiAudioPayloads(message); if (audioPayloads.length > 0) state.governedPlayback.assertProviderAudioAllowed(); state.semanticGate.observeProviderMessage(message); const delivered = options.emitControlEvent?.(state.claims, controlEnvelope); if (audioPayloads.length > 0 && delivered !== true && !state.playback.activeResponseId()) throw new Error("Gemini output audio requires active control sideband"); for (const payload of audioPayloads) { const pcm16le16k = state.resampler.push(decodeBase64(payload)); if (pcm16le16k.length === 0) continue; state.playback.queue(pcm16le16k); } emitPlaybackChunks(state.playback.flush()); } catch { closeBoth("GEMINI_MESSAGE_REJECTED"); } }); gemini.on("error", () => closeBoth("GEMINI_SOCKET_ERROR")); gemini.on("close", (code) => closeBoth("GEMINI_SOCKET_CLOSED", { closeCode: Number(code) })); };
    async function observeTelnyx(raw) { const message = parseJson(raw, "Telnyx media"); const event = message?.event; if (event === "connected") return; if (event === "start") { if (state.started) throw new Error("Telnyx media start is one-shot"); const verifiedStart = requireTelnyxStartForCredential(state.claims, message); const consumed = await options.consumeCredentialOnce(state.claims.credentialId, state.claims.notAfterEpochMs, Date.now()); if (consumed !== true) throw new Error("Gemini media edge credential already consumed"); const bootstrap = await options.consumeBootstrapForClaims(state.claims, Date.now()); state.streamId = verifiedStart.streamId; state.authorized = true; state.started = true; state.phase = "TELNYX_START_AUTHORIZED"; diagnose(state.phase); openGemini(bootstrap); return; } if (!state.authorized || !state.started) throw new Error("Telnyx media received before authorized start"); if (typeof message.stream_id === "string" && message.stream_id.trim() !== state.streamId) throw new Error("Telnyx media stream identity changed"); if (event === "stop") return closeBoth("TELNYX_STOP"); if (event === "mark") { const playbackEvent = state.playback.observeReturnedMark(required(message?.mark?.name, "Telnyx playback mark name")); if (playbackEvent) { const governed = state.governedPlayback.snapshot().activeResponseId === playbackEvent.responseId; if (governed) { if (!state.governedContext) throw new Error("Governed speech completion context is missing"); completeGovernedSpeechPlayback({ context: state.governedContext, event: playbackEvent, coordinator: state.governedPlayback, emitControlEvent: (envelope) => options.emitControlEvent?.(state.claims, envelope) }); state.governedContext = null; } else { options.emitControlEvent?.(state.claims, { type: "PLAYBACK_EVENT", event: playbackEvent }); } } return; } if (event !== "media" || message?.media?.track !== "inbound") return; const chunk = Number(message.media.chunk); if (!Number.isSafeInteger(chunk) || chunk < 1) throw new Error("Invalid Telnyx media chunk"); const payload = required(message.media.payload, "Telnyx media payload"); if (chunk < state.nextChunk) return; if (!state.buffered.has(chunk)) state.buffered.set(chunk, payload); if (state.buffered.size > 64) throw new Error("Telnyx media reorder window exceeded"); while (state.buffered.has(state.nextChunk)) { const ordered = state.buffered.get(state.nextChunk); state.buffered.delete(state.nextChunk); state.nextChunk += 1; const observation = await state.callerInput.observe(ordered, state.playback.activeResponseId()); const vad = observation.acoustic?.vad; for (const callerEvent of observation.events) { diagnose("CALLER_INPUT_EVENT", { type: callerEvent.type, rms: observation.acoustic?.rms, noiseFloorRms: vad?.noiseFloorRms, effectiveStopRms: vad?.effectiveStopRms }); if (options.emitControlEvent?.(state.claims, callerControlEnvelope(callerEvent)) !== true) throw new Error("Gemini caller evidence requires active control sideband"); } if (vad?.state === "SPEECH" && vad.processedSamples - state.lastVadDiagnosticSamples >= 80_000) { state.lastVadDiagnosticSamples = vad.processedSamples; diagnose("CALLER_VAD_ACTIVE", { rms: observation.acoustic.rms, noiseFloorRms: vad.noiseFloorRms, effectiveStopRms: vad.effectiveStopRms }); } } }
    telnyx.on("message", (raw) => { state.telnyxChain = state.telnyxChain.then(() => observeTelnyx(raw)).catch(() => closeBoth("TELNYX_MESSAGE_REJECTED")); }); telnyx.on("error", () => closeBoth("TELNYX_SOCKET_ERROR")); telnyx.on("close", (code) => closeBoth("TELNYX_SOCKET_CLOSED", { closeCode: Number(code) }));
  });
  return Object.freeze({ wss, handleUpgrade, activeSessions: () => sessions.size, async close() { for (const session of [...sessions]) { try { session.telnyx.close(); session.gemini?.close(); } catch {} } await new Promise((resolve) => wss.close(() => resolve())); } });
}
