const DEFAULT_THRESHOLD = 3;
const DEFAULT_MAX_OBSERVATIONS = 16;

function required(value, field, max = 256) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

/**
 * Call-local, constant-time escalation policy. Semantic interpretation remains
 * model-owned; this class owns only the deterministic repetition invariant.
 */
export class FastSemanticSecurityTerminationPolicy {
  constructor(options = {}) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.maxObservations = options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 2 || this.threshold > 8) {
      throw new Error("Fast semantic security threshold is invalid");
    }
    if (!Number.isSafeInteger(this.maxObservations) || this.maxObservations < this.threshold || this.maxObservations > 128) {
      throw new Error("Fast semantic security observation limit is invalid");
    }
    this.observedToolCalls = new Set();
    this.terminationIssued = false;
  }

  observe(input = {}) {
    const toolCallId = required(input.toolCallId, "Fast semantic security toolCallId");
    const category = required(input.category, "Fast semantic security category", 64);
    if (this.observedToolCalls.has(toolCallId)) {
      return Object.freeze({
        accepted: false,
        duplicate: true,
        observationCount: this.observedToolCalls.size,
        highConfidence: this.terminationIssued,
        terminate: false,
        category,
      });
    }
    if (this.observedToolCalls.size >= this.maxObservations) {
      throw new Error("Fast semantic security observation budget exceeded");
    }
    this.observedToolCalls.add(toolCallId);
    const highConfidence = this.observedToolCalls.size >= this.threshold;
    const terminate = highConfidence && !this.terminationIssued;
    if (terminate) this.terminationIssued = true;
    return Object.freeze({
      accepted: true,
      duplicate: false,
      observationCount: this.observedToolCalls.size,
      highConfidence,
      terminate,
      category,
    });
  }

  releaseTerminationAttempt() {
    if (this.observedToolCalls.size >= this.threshold) this.terminationIssued = false;
  }

  snapshot() {
    return Object.freeze({
      threshold: this.threshold,
      observationCount: this.observedToolCalls.size,
      terminationIssued: this.terminationIssued,
      maxObservations: this.maxObservations,
    });
  }
}
