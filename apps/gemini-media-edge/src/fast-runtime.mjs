import { WebSocket } from "ws";
import {
  buildFastFunctionResponse,
  buildFastGemini31Setup,
  parseFastGemini31ServerFrame,
} from "./fast-gemini31.mjs";
import {
  FastPcm24To16Resampler,
  geminiAudioToTelnyxMedia,
  telnyxClearPlaybackMessage,
  telnyxInboundMediaToGemini,
} from "./fast-audio-bridge.mjs";
import { FastGeminiToolExecutor } from "./fast-tool-executor.mjs";

const OPEN = 1;
const CONNECTING = 0;
const GEMINI_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;
const DEFAULT_MAX_PRESETUP_CHUNKS = 128;

function required(value, field, max = 64_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /\u0000/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function safeSend(socket, value, label, maxBufferedBytes) {
  if (!socket || socket.readyState !== OPEN) throw new Error(`${label} socket is not open`);
  if (Number(socket.bufferedAmount ?? 0) > maxBufferedBytes) throw new Error(`${label} socket backpressure limit exceeded`);
  socket.send(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}

function safeClose(socket, code = 1000, reason = "closed") {
  try {
    if (socket && (socket.readyState === OPEN || socket.readyState === CONNECTING)) socket.close(code, reason);
  } catch {}
}

function parseJson(raw, label) {
  try { return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")); }
  catch { throw new Error(`${label} JSON is invalid`); }
}

function latencyMicros(startedNs) {
  return Number((process.hrtime.bigint() - startedNs) / 1_000n);
}

function speechStateFromMessage(message) {
  const server = message?.serverContent ?? message?.server_content ?? null;
  const value = server?.speechState ?? server?.speech_state ?? null;
  return value === "SPEECH" || value === "NON_SPEECH" ? value : null;
}

/**
 * One-call Gemini fast-path owner.
 *
 * Deliberately absent: control-sideband, Google STT, Google TTS, semantic
 * preselection, provider rotation, governed speech and Durable Object hops.
 */
export class FastGeminiRealtimeSession {
  constructor(options = {}) {
    this.telnyx = options.telnyxSocket;
    if (!this.telnyx || typeof this.telnyx.send !== "function") throw new Error("Fast Gemini Telnyx socket is required");
    this.bootstrap = options.bootstrap;
    if (!this.bootstrap || this.bootstrap.provider !== "GEMINI") throw new Error("Fast Gemini bootstrap is required");
    this.apiKey = required(options.geminiApiKey, "GEMINI_API_KEY", 8_192);
    this.model = options.model ?? "gemini-3.1-flash-live-preview";
    this.createGeminiSocket = options.createGeminiSocket ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
    this.observe = typeof options.observe === "function" ? options.observe : () => {};
    this.maxBufferedBytes = Number.isSafeInteger(options.maxBufferedBytes) ? options.maxBufferedBytes : DEFAULT_MAX_BUFFERED_BYTES;
    this.maxPreSetupChunks = Number.isSafeInteger(options.maxPreSetupChunks) ? options.maxPreSetupChunks : DEFAULT_MAX_PRESETUP_CHUNKS;
    if (this.maxBufferedBytes < 65_536 || this.maxPreSetupChunks < 1) throw new Error("Fast Gemini runtime limits are invalid");
    this.toolExecutor = options.toolExecutor instanceof FastGeminiToolExecutor
      ? options.toolExecutor
      : new FastGeminiToolExecutor({ handlers: options.toolHandlers });
    this.resampler = new FastPcm24To16Resampler();
    this.gemini = null;
    this.setupComplete = false;
    this.closed = false;
    this.preSetupMedia = [];
    this.toolChain = Promise.resolve();
    this.lastResumptionToken = null;
    this.lastCallerMediaAtNs = null;
    this.lastGeminiAudioAtNs = null;
    this.firstGeminiAudioObserved = false;
    this.pendingCallerSpeechEndAtNs = null;
    this.pendingResponseLatencyMicros = null;
  }

  start() {
    if (this.closed || this.gemini) throw new Error("Fast Gemini session cannot start twice");
    const url = new URL(GEMINI_ENDPOINT);
    url.searchParams.set("key", this.apiKey);
    const gemini = this.createGeminiSocket(url, { perMessageDeflate: false });
    if (!gemini || typeof gemini.on !== "function" || typeof gemini.send !== "function" || typeof gemini.close !== "function") {
      throw new Error("Fast Gemini socket factory returned an invalid socket");
    }
    this.gemini = gemini;
    this.#bindGemini(gemini);
    this.#bindTelnyx();
    this.#emit("FAST_SESSION_STARTED");
    return this;
  }

  #bindGemini(gemini) {
    gemini.on("open", () => {
      if (this.closed || this.gemini !== gemini) return;
      try {
        safeSend(gemini, buildFastGemini31Setup({
          model: this.model,
          systemInstruction: this.bootstrap.systemInstruction,
          tools: this.bootstrap.tools,
          voiceName: this.bootstrap.voiceName,
          languageCode: this.bootstrap.languageCode,
        }), "Gemini", this.maxBufferedBytes);
        this.#emit("GEMINI_SETUP_SENT");
      } catch (error) {
        this.close("GEMINI_SETUP_SEND_FAILED", error);
      }
    });

    gemini.on("message", (raw) => {
      if (this.closed || this.gemini !== gemini) return;
      const startedNs = process.hrtime.bigint();
      try {
        const message = parseJson(raw, "Gemini Live");
        const frame = parseFastGemini31ServerFrame(message);
        const speechState = speechStateFromMessage(message);
        if (frame.setupComplete) {
          if (this.setupComplete) throw new Error("Gemini setupComplete repeated");
          this.setupComplete = true;
          this.#emit("GEMINI_SETUP_COMPLETE", { queuedCallerChunks: this.preSetupMedia.length });
          this.#flushPreSetupMedia();
        } else if (!this.setupComplete) {
          throw new Error("Gemini sent content before setupComplete");
        }

        if (frame.sessionResumptionToken) this.lastResumptionToken = frame.sessionResumptionToken;
        if (frame.goAwayTimeLeftMs !== null) this.#emit("GEMINI_GO_AWAY", { timeLeftMs: frame.goAwayTimeLeftMs });

        if (speechState === "SPEECH") {
          this.pendingCallerSpeechEndAtNs = null;
          this.pendingResponseLatencyMicros = null;
        } else if (speechState === "NON_SPEECH") {
          this.pendingCallerSpeechEndAtNs = process.hrtime.bigint();
          this.pendingResponseLatencyMicros = null;
        }

        if (frame.interrupted) {
          safeSend(this.telnyx, telnyxClearPlaybackMessage(), "Telnyx", this.maxBufferedBytes);
          this.resampler.reset();
          this.#emit("BARGE_IN_CLEAR_SENT");
        }

        for (const audioPart of frame.audio) {
          const media = geminiAudioToTelnyxMedia(audioPart, this.resampler);
          if (!media) continue;
          safeSend(this.telnyx, media, "Telnyx", this.maxBufferedBytes);
          this.lastGeminiAudioAtNs = process.hrtime.bigint();
          if (this.pendingCallerSpeechEndAtNs !== null && this.pendingResponseLatencyMicros === null) {
            this.pendingResponseLatencyMicros = Number((this.lastGeminiAudioAtNs - this.pendingCallerSpeechEndAtNs) / 1_000n);
          }
          if (!this.firstGeminiAudioObserved) {
            this.firstGeminiAudioObserved = true;
            this.#emit("FIRST_GEMINI_AUDIO_TO_TELNYX", {
              ...(this.lastCallerMediaAtNs ? { sinceLastCallerMediaMicros: Number((this.lastGeminiAudioAtNs - this.lastCallerMediaAtNs) / 1_000n) } : {}),
            });
          }
        }

        for (const toolCall of frame.toolCalls) this.#enqueueToolCall(toolCall);
        if (frame.turnComplete) {
          this.#emit("GEMINI_TURN_COMPLETE", {
            ...(this.pendingResponseLatencyMicros !== null ? {
              observedMs: Math.round(this.pendingResponseLatencyMicros / 1_000),
              phase: "speech_end_to_first_audio",
              type: "gemini_speech_state",
            } : {}),
          });
          this.pendingCallerSpeechEndAtNs = null;
          this.pendingResponseLatencyMicros = null;
        }
        this.#emit("GEMINI_FRAME_PROCESSED", { localProcessingMicros: latencyMicros(startedNs), audioParts: frame.audio.length, toolCalls: frame.toolCalls.length });
      } catch (error) {
        this.close("GEMINI_FRAME_REJECTED", error);
      }
    });
    gemini.on("error", (error) => this.close("GEMINI_SOCKET_ERROR", error));
    gemini.on("close", (code) => {
      if (!this.closed) this.close("GEMINI_SOCKET_CLOSED", new Error(`Gemini close ${Number(code)}`));
    });
  }

  #bindTelnyx() {
    this.telnyx.on("message", (raw) => {
      if (this.closed) return;
      const startedNs = process.hrtime.bigint();
      try {
        const message = parseJson(raw, "Telnyx media");
        if (message.event === "connected" || message.event === "mark") return;
        if (message.event === "stop") return this.close("TELNYX_STOP");
        const bridged = telnyxInboundMediaToGemini(message);
        if (!bridged) return;
        this.lastCallerMediaAtNs = process.hrtime.bigint();
        if (!this.setupComplete || this.gemini?.readyState !== OPEN) {
          this.preSetupMedia.push(bridged.geminiMessage);
          if (this.preSetupMedia.length > this.maxPreSetupChunks) throw new Error("Fast Gemini pre-setup caller audio buffer exceeded");
        } else {
          safeSend(this.gemini, bridged.geminiMessage, "Gemini", this.maxBufferedBytes);
        }
        this.#emit("CALLER_CHUNK_FORWARDED", { chunk: bridged.chunk, localProcessingMicros: latencyMicros(startedNs), queuedBeforeSetup: !this.setupComplete });
      } catch (error) {
        this.close("TELNYX_FRAME_REJECTED", error);
      }
    });
    this.telnyx.on("error", (error) => this.close("TELNYX_SOCKET_ERROR", error));
    this.telnyx.on("close", (code) => {
      if (!this.closed) this.close("TELNYX_SOCKET_CLOSED", new Error(`Telnyx close ${Number(code)}`));
    });
  }

  #flushPreSetupMedia() {
    if (!this.setupComplete || this.gemini?.readyState !== OPEN) return;
    const queued = this.preSetupMedia.splice(0);
    for (const message of queued) safeSend(this.gemini, message, "Gemini", this.maxBufferedBytes);
    if (queued.length) this.#emit("PRESETUP_CALLER_AUDIO_FLUSHED", { chunks: queued.length });
  }

  #enqueueToolCall(toolCall) {
    this.toolChain = this.toolChain.then(async () => {
      if (this.closed) return;
      const startedNs = process.hrtime.bigint();
      try {
        const result = await this.toolExecutor.execute(toolCall, {
          tenantId: this.bootstrap.tenantId,
          callControlId: this.bootstrap.callControlId,
        });
        if (this.closed) return;
        safeSend(this.gemini, buildFastFunctionResponse(toolCall, result), "Gemini", this.maxBufferedBytes);
        this.#emit("TOOL_RESULT_SENT", { toolName: toolCall.name, toolCallId: toolCall.id, durationMicros: latencyMicros(startedNs) });
      } catch (error) {
        this.close("TOOL_EXECUTION_FAILED", error);
      }
    });
  }

  #emit(stage, details = {}) {
    try {
      this.observe(Object.freeze({
        stage,
        tenantId: this.bootstrap.tenantId,
        callControlId: this.bootstrap.callControlId,
        ...details,
      }));
    } catch {}
  }

  snapshot() {
    return Object.freeze({
      closed: this.closed,
      setupComplete: this.setupComplete,
      queuedCallerChunks: this.preSetupMedia.length,
      hasResumptionToken: Boolean(this.lastResumptionToken),
      toolState: this.toolExecutor.snapshot(),
    });
  }

  close(reason = "CLOSED", error = null) {
    if (this.closed) return;
    this.closed = true;
    this.preSetupMedia.length = 0;
    this.pendingCallerSpeechEndAtNs = null;
    this.pendingResponseLatencyMicros = null;
    this.resampler.reset();
    this.#emit("FAST_SESSION_CLOSED", {
      reason,
      ...(error instanceof Error ? { errorCategory: error.name || "Error" } : {}),
    });
    safeClose(this.gemini, 1000, reason.slice(0, 120));
    safeClose(this.telnyx, 1000, reason.slice(0, 120));
  }
}
