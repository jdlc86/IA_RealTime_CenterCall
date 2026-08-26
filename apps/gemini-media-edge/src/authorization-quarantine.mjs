const PCM_OUTPUT_RATE_HZ = 24_000;
const PCM_BYTES_PER_SAMPLE = 2;
export const MAX_QUARANTINE_AUDIO_BYTES = 128 * 1024;
export const MAX_QUARANTINE_TOOL_CALLS = 8;
export const MAX_QUARANTINE_DURATION_MS = Math.floor(
  (MAX_QUARANTINE_AUDIO_BYTES * 1000) / (PCM_OUTPUT_RATE_HZ * PCM_BYTES_PER_SAMPLE),
);

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function audioChunk(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error("Quarantine audio chunk is invalid");
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length % PCM_BYTES_PER_SAMPLE !== 0) throw new Error("Quarantine audio chunk must contain complete PCM16 samples");
  return bytes;
}

function toolCall(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Quarantine tool call is invalid");
  const toolCallId = required(value.toolCallId, "Quarantine tool call id");
  const toolName = required(value.toolName, "Quarantine tool name");
  if (!("arguments" in value)) throw new Error("Quarantine tool arguments are required");
  return Object.freeze({ toolCallId, toolName, arguments: structuredClone(value.arguments) });
}

/**
 * Provider-local hold for output produced before the Control Plane authorizes a
 * caller turn. This owner deliberately has no timers: release/reject is driven
 * only by exact turn identity and explicit control evidence.
 */
export class TurnAuthorizationQuarantine {
  constructor(options = {}) {
    const maxAudioBytes = Number(options.maxAudioBytes ?? MAX_QUARANTINE_AUDIO_BYTES);
    const maxToolCalls = Number(options.maxToolCalls ?? MAX_QUARANTINE_TOOL_CALLS);
    if (!Number.isSafeInteger(maxAudioBytes) || maxAudioBytes < 2 || maxAudioBytes > 1024 * 1024) {
      throw new Error("Quarantine maxAudioBytes is invalid");
    }
    if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 32) {
      throw new Error("Quarantine maxToolCalls is invalid");
    }
    this.maxAudioBytes = maxAudioBytes;
    this.maxToolCalls = maxToolCalls;
    this.reset();
  }

  begin(turnId, generationId) {
    if (this.state !== "IDLE") throw new Error("Quarantine already owns a turn");
    this.turnId = required(turnId, "Quarantine turn id");
    this.generationId = required(generationId, "Quarantine generation id");
    this.state = "PENDING";
    return this.snapshot();
  }

  pushAudio(generationId, value) {
    this.requirePendingGeneration(generationId);
    const bytes = audioChunk(value);
    if (this.audioBytes + bytes.length > this.maxAudioBytes) {
      const result = Object.freeze({
        action: "CLEAN_RESTART_REQUIRED",
        reason: "QUARANTINE_AUDIO_LIMIT",
        turnId: this.turnId,
        generationId: this.generationId,
        bufferedAudioBytes: this.audioBytes,
      });
      this.reset();
      return result;
    }
    this.audio.push(bytes);
    this.audioBytes += bytes.length;
    return Object.freeze({ action: "BUFFERED", bufferedAudioBytes: this.audioBytes });
  }

  holdTool(generationId, value) {
    this.requirePendingGeneration(generationId);
    if (this.tools.length >= this.maxToolCalls) {
      const result = Object.freeze({
        action: "CLEAN_RESTART_REQUIRED",
        reason: "QUARANTINE_TOOL_LIMIT",
        turnId: this.turnId,
        generationId: this.generationId,
        bufferedToolCalls: this.tools.length,
      });
      this.reset();
      return result;
    }
    const call = toolCall(value);
    if (this.tools.some((existing) => existing.toolCallId === call.toolCallId)) {
      throw new Error("Quarantine duplicate tool call id");
    }
    this.tools.push(call);
    return Object.freeze({ action: "HELD", bufferedToolCalls: this.tools.length });
  }

  authorize(turnId) {
    this.requirePendingTurn(turnId);
    const release = Object.freeze({
      action: "RELEASE",
      turnId: this.turnId,
      generationId: this.generationId,
      audio: Object.freeze(this.audio.map((chunk) => Buffer.from(chunk))),
      toolCalls: Object.freeze(this.tools.map((call) => structuredClone(call))),
      audioBytes: this.audioBytes,
    });
    this.reset();
    return release;
  }

  reject(turnId, terminal) {
    this.requirePendingTurn(turnId);
    if (typeof terminal !== "boolean") throw new Error("Quarantine rejection terminal flag is required");
    const result = Object.freeze({
      action: terminal ? "TERMINATE_PROVIDER" : "CLEAN_RESTART_REQUIRED",
      reason: terminal ? "TURN_REJECTED_TERMINAL" : "TURN_REJECTED_UNTRUSTED_CONTEXT",
      turnId: this.turnId,
      generationId: this.generationId,
      discardedAudioBytes: this.audioBytes,
      discardedToolCalls: this.tools.length,
    });
    this.reset();
    return result;
  }

  snapshot() {
    return Object.freeze({
      state: this.state,
      turnId: this.turnId,
      generationId: this.generationId,
      audioBytes: this.audioBytes,
      toolCalls: this.tools.length,
    });
  }

  requirePendingTurn(turnId) {
    if (this.state !== "PENDING") throw new Error("Quarantine has no pending turn");
    if (required(turnId, "Quarantine turn id") !== this.turnId) throw new Error("Quarantine turn identity mismatch");
  }

  requirePendingGeneration(generationId) {
    if (this.state !== "PENDING") throw new Error("Quarantine has no pending turn");
    if (required(generationId, "Quarantine generation id") !== this.generationId) throw new Error("Quarantine generation identity mismatch");
  }

  reset() {
    this.state = "IDLE";
    this.turnId = null;
    this.generationId = null;
    this.audio = [];
    this.audioBytes = 0;
    this.tools = [];
  }
}
