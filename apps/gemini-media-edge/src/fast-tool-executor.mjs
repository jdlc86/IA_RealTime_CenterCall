const DEFAULT_MAX_ARGUMENT_BYTES = 32 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_MAX_CALLS = 128;

function requiredString(value, field, max = 256) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\r\n\t\u0000]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function jsonBytes(value, field, maxBytes) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error(`${field} is not JSON serializable`); }
  if (encoded === undefined) throw new Error(`${field} is not JSON serializable`);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > maxBytes) throw new Error(`${field} exceeds configured limit`);
  return { encoded, bytes };
}

/**
 * Per-call tool boundary for the low-latency Gemini runtime.
 * It owns transport idempotency only. Business idempotency remains inside the
 * domain handler (e.g. reservation command id / booking id). An empty handler
 * set is valid for voice-only probes and fails closed if Gemini calls a tool.
 */
export class FastGeminiToolExecutor {
  constructor(options = {}) {
    const handlers = options.handlers ?? {};
    if (typeof handlers !== "object" || Array.isArray(handlers)) {
      throw new Error("Fast Gemini tool handlers are invalid");
    }
    this.handlers = new Map();
    for (const [name, handler] of Object.entries(handlers)) {
      const normalized = requiredString(name, "Fast Gemini tool name", 128);
      if (!/^[A-Za-z0-9_-]+$/.test(normalized) || typeof handler !== "function") {
        throw new Error(`Fast Gemini tool handler ${normalized} is invalid`);
      }
      this.handlers.set(normalized, handler);
    }
    this.maxArgumentBytes = options.maxArgumentBytes ?? DEFAULT_MAX_ARGUMENT_BYTES;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    this.maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
    for (const [value, field] of [
      [this.maxArgumentBytes, "maxArgumentBytes"],
      [this.maxResultBytes, "maxResultBytes"],
      [this.maxCalls, "maxCalls"],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Fast Gemini ${field} is invalid`);
    }
    this.completed = new Map();
    this.inFlight = new Map();
  }

  async execute(call, context = {}) {
    if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error("Fast Gemini function call is invalid");
    const id = requiredString(call.id, "Fast Gemini function call id");
    const name = requiredString(call.name, "Fast Gemini function call name", 128);
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Fast Gemini tool is not allowed: ${name}`);
    const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? structuredClone(call.args) : {};
    const argsJson = jsonBytes(args, "Fast Gemini tool arguments", this.maxArgumentBytes).encoded;
    const identity = `${name}\n${argsJson}`;

    const completed = this.completed.get(id);
    if (completed) {
      if (completed.identity !== identity) throw new Error("Fast Gemini function call id was reused with different content");
      return completed.result;
    }
    const inFlight = this.inFlight.get(id);
    if (inFlight) {
      if (inFlight.identity !== identity) throw new Error("Fast Gemini function call id was reused while in flight");
      return inFlight.promise;
    }
    if (this.completed.size + this.inFlight.size >= this.maxCalls) throw new Error("Fast Gemini tool call budget exceeded");

    const promise = (async () => {
      const result = await handler(Object.freeze({ id, name, args }), Object.freeze({ ...context }));
      jsonBytes(result, "Fast Gemini tool result", this.maxResultBytes);
      const frozen = result && typeof result === "object" ? Object.freeze(structuredClone(result)) : result;
      this.completed.set(id, Object.freeze({ identity, result: frozen }));
      return frozen;
    })();
    this.inFlight.set(id, Object.freeze({ identity, promise }));
    try {
      return await promise;
    } finally {
      this.inFlight.delete(id);
    }
  }

  snapshot() {
    return Object.freeze({
      allowedTools: Object.freeze([...this.handlers.keys()].sort()),
      completedCalls: this.completed.size,
      inFlightCalls: this.inFlight.size,
      maxCalls: this.maxCalls,
    });
  }
}
