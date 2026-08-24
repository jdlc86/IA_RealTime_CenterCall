import {
  AuthoritativeCallerInputOwner as CoreAuthoritativeCallerInputOwner,
  TelnyxSampleCountVad,
} from "./caller-input-core.mjs";

export { TelnyxSampleCountVad };

const SAMPLE_RATE_HZ = 16_000;
const pendingDiagnosticOwners = [];

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function safeContext(value) {
  return Object.freeze({
    tenantId: required(value?.tenantId, "Gemini caller diagnostic tenant_id"),
    callControlId: required(value?.callControlId, "Gemini caller diagnostic call_control_id"),
  });
}

function payloadMetrics(payloads) {
  let bytes = 0;
  for (const payload of payloads ?? []) {
    try { bytes += Buffer.from(required(payload, "Gemini caller diagnostic payload"), "base64").length; }
    catch { return Object.freeze({ chunkCount: Array.isArray(payloads) ? payloads.length : 0, sampleCount: 0, audioDurationMs: 0 }); }
  }
  const sampleCount = Math.floor(bytes / 2);
  return Object.freeze({
    chunkCount: Array.isArray(payloads) ? payloads.length : 0,
    sampleCount,
    audioDurationMs: Math.round((sampleCount * 1000) / SAMPLE_RATE_HZ),
  });
}

function classifySttFailure(error) {
  const message = error instanceof Error ? error.message : "";
  const http = message.match(/HTTP\s+(\d{3})/);
  if (message.includes("access token")) return Object.freeze({ errorCode: "STT_AUTH_FAILED", httpStatus: null });
  if (message.includes("recognition request failed")) return Object.freeze({ errorCode: "STT_NETWORK_FAILED", httpStatus: null });
  if (http) return Object.freeze({ errorCode: "STT_HTTP_ERROR", httpStatus: Number(http[1]) });
  if (message.includes("response is invalid")) return Object.freeze({ errorCode: "STT_RESPONSE_INVALID", httpStatus: null });
  if (message.includes("no transcript")) return Object.freeze({ errorCode: "STT_EMPTY_TRANSCRIPT", httpStatus: null });
  return Object.freeze({ errorCode: "STT_FAILED", httpStatus: null });
}

export function bindNextCallerInputDiagnosticContext(context) {
  const owner = pendingDiagnosticOwners.shift();
  if (!owner) return false;
  owner.bindDiagnosticContext(safeContext(context));
  return true;
}

/**
 * Thin observability layer. Transcript text remains exclusively inside the
 * semantic sideband path and is never passed to observeDiagnostic.
 */
export class AuthoritativeCallerInputOwner extends CoreAuthoritativeCallerInputOwner {
  constructor(transcribe, vadConfig, options = {}) {
    const observer = typeof options?.observeDiagnostic === "function" ? options.observeDiagnostic : null;
    const coreOptions = { ...options };
    delete coreOptions.observeDiagnostic;
    super(transcribe, vadConfig, coreOptions);
    this.diagnosticObserver = observer;
    this.diagnosticContext = null;
    if (observer) {
      pendingDiagnosticOwners.push(this);
      if (pendingDiagnosticOwners.length > 32) pendingDiagnosticOwners.shift();
    }

    const underlyingTranscribe = this.transcribe;
    this.transcribe = async (request) => {
      const metrics = payloadMetrics(request?.payloads);
      const itemId = required(request?.itemId, "Gemini caller diagnostic item id");
      this.emitDiagnostic("VAD_SPEECH_STOPPED", { component: "gemini-media-edge", itemId, ...metrics });
      this.emitDiagnostic("STT_STARTED", { component: "google-speech", itemId, ...metrics });
      const startedAt = Date.now();
      try {
        const result = await underlyingTranscribe(request);
        this.emitDiagnostic("STT_COMPLETED", {
          component: "google-speech",
          itemId,
          durationMs: Date.now() - startedAt,
          ...metrics,
        });
        return result;
      } catch (error) {
        const failure = classifySttFailure(error);
        this.emitDiagnostic("STT_FAILED", {
          component: "google-speech",
          itemId,
          severity: "error",
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
          durationMs: Date.now() - startedAt,
          ...metrics,
        });
        throw error;
      }
    };
  }

  bindDiagnosticContext(context) {
    if (this.diagnosticContext) return false;
    this.diagnosticContext = context;
    return true;
  }

  emitDiagnostic(stage, details = {}) {
    if (!this.diagnosticObserver || !this.diagnosticContext) return;
    try {
      this.diagnosticObserver({
        stage,
        tenantId: this.diagnosticContext.tenantId,
        callControlId: this.diagnosticContext.callControlId,
        ...details,
      });
    } catch {
      // Telemetry must never affect caller media or semantic ownership.
    }
  }

  async observe(payload, playbackResponseId = null) {
    const result = await super.observe(payload, playbackResponseId);
    for (const event of result.events ?? []) {
      if (event.type === "CALLER_SPEECH_STARTED") {
        this.emitDiagnostic("VAD_SPEECH_STARTED", {
          component: "gemini-media-edge",
          itemId: event.itemId,
          responseId: event.playbackResponseIdAtStart ?? null,
          rms: result.acoustic?.rms,
          noiseFloorRms: result.acoustic?.vad?.noiseFloorRms,
          effectiveStopRms: result.acoustic?.vad?.effectiveStopRms,
        });
      }
      if (event.type === "CALLER_TRANSCRIPT_COMPLETED") {
        this.emitDiagnostic("TRANSCRIPT_AUTHORITY_COMPLETED", {
          component: "gemini-media-edge",
          itemId: event.itemId,
          responseId: event.playbackResponseIdAtStart ?? null,
        });
      }
    }
    return result;
  }
}
