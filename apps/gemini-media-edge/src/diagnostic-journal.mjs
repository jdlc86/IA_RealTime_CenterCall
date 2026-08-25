import { randomUUID } from "node:crypto";

const DEFAULT_MAX_CALLS = 64;
const DEFAULT_MAX_EVENTS_PER_CALL = 512;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > 512 || /[\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function code(value, field) {
  const normalized = required(value, field);
  if (!/^[A-Z0-9_]+$/.test(normalized) || normalized.length > 128) throw new Error(`${field} is invalid`);
  return normalized;
}

function boundedInteger(value, max) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) return null;
  return number;
}

function boundedNumber(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1_000_000_000 ? number : null;
}

function safeOpaque(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = required(value, "diagnostic identity");
  return /^\S+$/.test(normalized) ? normalized : null;
}

function safeDetailCode(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  return normalized.length <= 128 && /^[A-Za-z0-9_.:+-]+$/.test(normalized) ? normalized : null;
}

function defaultComponent(stage) {
  if (stage.startsWith("STT_")) return "google-speech";
  if (stage.startsWith("GEMINI_")) return "gemini-live";
  return "gemini-media-edge";
}

function defaultPlane(component) {
  return component === "google-speech" || component === "gemini-live" ? "provider" : "media_edge";
}

function safeDetails(input) {
  const details = {};
  const codeFields = [
    ["phase", input.phase],
    ["reason", input.reason],
    ["kind", input.kind ?? input.selectedTool],
    ["type", input.type],
    ["providerErrorCode", input.providerErrorCode],
  ];
  for (const [key, value] of codeFields) {
    const safe = safeDetailCode(value);
    if (safe !== null) {
      const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      details[snake] = safe;
    }
  }
  const numericFields = [
    ["rms", input.rms],
    ["noise_floor_rms", input.noiseFloorRms],
    ["effective_stop_rms", input.effectiveStopRms],
    ["close_code", input.closeCode],
    ["http_status", input.httpStatus],
  ];
  for (const [key, value] of numericFields) {
    const safe = boundedNumber(value);
    if (safe !== null) details[key] = safe;
  }
  if (typeof input.directModelOutputAllowed === "boolean") {
    details.authorized = input.directModelOutputAllowed;
    details.direct_model_output_allowed = input.directModelOutputAllowed;
  }
  return Object.freeze(details);
}

function errorCodeFor(input, stage) {
  if (input.errorCode !== undefined && input.errorCode !== null) return code(input.errorCode, "diagnostic errorCode");
  if (stage.endsWith("_FAILED") || stage.endsWith("_REJECTED") || stage.endsWith("_ERROR")) return stage;
  if (stage === "MEDIA_SESSION_CLOSING") {
    const reason = safeDetailCode(input.reason);
    if (reason && /(?:FAILED|REJECTED|ERROR)/.test(reason)) return reason;
  }
  return null;
}

export class InMemoryDiagnosticJournal {
  constructor(options = {}) {
    this.maxCalls = Number(options.maxCalls ?? DEFAULT_MAX_CALLS);
    this.maxEventsPerCall = Number(options.maxEventsPerCall ?? DEFAULT_MAX_EVENTS_PER_CALL);
    this.ttlMs = Number(options.ttlMs ?? DEFAULT_TTL_MS);
    if (!Number.isSafeInteger(this.maxCalls) || this.maxCalls < 1 || this.maxCalls > 1024) throw new Error("Diagnostic journal maxCalls is invalid");
    if (!Number.isSafeInteger(this.maxEventsPerCall) || this.maxEventsPerCall < 1 || this.maxEventsPerCall > 4096) throw new Error("Diagnostic journal maxEventsPerCall is invalid");
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 60_000 || this.ttlMs > 24 * 60 * 60 * 1000) throw new Error("Diagnostic journal ttlMs is invalid");
    this.calls = new Map();
  }

  cleanup(nowEpochMs) {
    for (const [callControlId, bucket] of this.calls) {
      if (nowEpochMs >= bucket.expiresAtEpochMs) this.calls.delete(callControlId);
    }
    while (this.calls.size > this.maxCalls) this.calls.delete(this.calls.keys().next().value);
  }

  record(input, nowEpochMs = Date.now()) {
    const now = Number(nowEpochMs);
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Diagnostic journal time is invalid");
    this.cleanup(now);
    const tenantId = required(input?.tenantId, "diagnostic tenantId");
    const callControlId = required(input?.callControlId, "diagnostic callControlId");
    const stage = code(input?.stage, "diagnostic stage");
    let bucket = this.calls.get(callControlId);
    if (!bucket) {
      bucket = {
        epoch: randomUUID(),
        startedAtEpochMs: now,
        expiresAtEpochMs: now + this.ttlMs,
        nextSequence: 0,
        lastEventId: null,
        events: [],
      };
      this.calls.set(callControlId, bucket);
      this.cleanup(now);
    }
    bucket.expiresAtEpochMs = now + this.ttlMs;
    bucket.nextSequence += 1;
    const component = safeDetailCode(input.component) ?? defaultComponent(stage);
    const plane = input.plane === "provider" || input.plane === "media_edge" ? input.plane : defaultPlane(component);
    const errorCode = errorCodeFor(input, stage);
    const eventId = `${callControlId}:media_edge:${bucket.epoch}:${bucket.nextSequence}`;
    const event = Object.freeze({
      event_id: eventId,
      occurred_at: new Date(now).toISOString(),
      call_id: callControlId,
      call_control_id: callControlId,
      tenant_id: tenantId,
      plane,
      component,
      stage,
      severity: input.severity === "error" || errorCode ? "error" : "info",
      error_code: errorCode,
      sequence: bucket.nextSequence,
      causal_parent_event_id: bucket.lastEventId,
      response_id: safeOpaque(input.responseId),
      item_id: safeOpaque(input.itemId),
      stream_id: safeOpaque(input.streamId),
      elapsed_ms: Math.max(0, now - bucket.startedAtEpochMs),
      duration_ms: boundedInteger(input.durationMs, 3_600_000),
      audio_duration_ms: boundedInteger(input.audioDurationMs, 3_600_000),
      chunk_count: boundedInteger(input.chunkCount, 100_000),
      sample_count: boundedInteger(input.sampleCount, 57_600_000),
      details: safeDetails(input),
    });
    bucket.lastEventId = eventId;
    bucket.events.push(event);
    if (bucket.events.length > this.maxEventsPerCall) bucket.events.splice(0, bucket.events.length - this.maxEventsPerCall);
    return event;
  }

  read(callControlId, nowEpochMs = Date.now()) {
    const id = required(callControlId, "diagnostic callControlId");
    const now = Number(nowEpochMs);
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Diagnostic journal time is invalid");
    this.cleanup(now);
    const bucket = this.calls.get(id);
    return Object.freeze(bucket ? [...bucket.events] : []);
  }

  size(nowEpochMs = Date.now()) {
    this.cleanup(Number(nowEpochMs));
    return this.calls.size;
  }
}
