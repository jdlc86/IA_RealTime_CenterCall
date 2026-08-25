import { AsyncLocalStorage } from "node:async_hooks";

const bindingContext = new AsyncLocalStorage();
const PATCHED = Symbol("geminiPostToolPlaybackSuppressionPatched");
const SUPPRESS_PROVIDER_AUDIO = Symbol("geminiSuppressPostToolProviderAudio");

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringField(value, key) {
  return typeof value?.[key] === "string" ? value[key] : "";
}

function hasMissingFields(value) {
  return Array.isArray(value?.missing)
    && value.missing.some((item) => typeof item === "string" && item.trim().length > 0);
}

function responseId(command, field = "Gemini post-tool playback response id") {
  const value = typeof command?.responseId === "string" ? command.responseId.trim() : "";
  if (!value) throw new Error(`${field} is required`);
  return value;
}

/**
 * Mirrors only post-tool outcomes that the existing Control Plane replaces with
 * governed speech. It does not decide business semantics and deliberately
 * returns false for ambiguous/non-terminal outputs.
 */
export function shouldSuppressGeminiPostToolProviderAudio(command) {
  if (command?.type !== "TOOL_RESULT") return false;
  const tool = typeof command.toolName === "string" ? command.toolName : "";
  const output = record(command.output);
  if (!tool || !output) return false;

  const status = stringField(output, "status");
  const stage = stringField(output, "stage");
  const reason = stringField(output, "reason");

  if (status === "REJECTED" && reason === "DUPLICATE_SEMANTIC_DECISION") return true;

  if (
    tool === "restaurant_reservation_create"
    && (stage === "AVAILABILITY_CHANGED" || status === "AVAILABILITY_CHANGED")
    && output.reservation_created === false
    && output.requires_new_confirmation === true
  ) return true;

  if (
    tool === "restaurant_reservation_create"
    && status === "UNAVAILABLE_WITH_SEARCH_OPTION"
    && output.requested_available === false
  ) return true;

  if (
    (tool === "restaurant_reservation_create" || tool === "restaurant_reservation_search")
    && status === "MISSING_INFORMATION"
    && hasMissingFields(output)
  ) return true;

  if (
    (tool === "restaurant_reservation_create" || tool === "restaurant_reservation_modify")
    && status === "TIME_EVIDENCE_REQUIRED"
  ) return true;

  if (
    tool === "restaurant_reservation_create"
    && stage === "BOOKED"
    && output.ask_marketing_consent !== true
  ) return true;

  if (tool === "restaurant_marketing_preferences" && ["MARKETING_UPDATED", "MARKETING_STATUS"].includes(status)) return true;
  if (tool === "restaurant_reservation_query" && ["FOUND", "NONE"].includes(status)) return true;
  if (tool === "restaurant_reservation_cancel" && ["CANCELLED", "NO_RESERVATIONS", "PARTIAL_FAILURE"].includes(status)) return true;
  if (tool === "restaurant_reservation_modify" && ["MODIFIED", "NO_RESERVATIONS"].includes(status)) return true;
  if (tool === "restaurant_business_info" && status === "FOUND") return true;

  return false;
}

function forwardAfter(delegateResult, next) {
  if (delegateResult && typeof delegateResult.then === "function") {
    return Promise.resolve(delegateResult).then(next);
  }
  return next();
}

/**
 * Serializes Gemini Live's automatic post-tool response with the existing
 * Control Plane governed response. Gemini may start a normal provider response
 * after FunctionResponse even when the Control Plane has already selected exact
 * governed speech. We keep that provider response physically silent, retain its
 * empty playback binding until its real provider completion/drain, and only then
 * forward the already-authorized governed speech. No provider event, function
 * call id, or tool decision is synthesized.
 */
export function createGeminiPostToolControlSink(delegate, hooks = {}) {
  if (typeof delegate !== "function") throw new Error("Gemini post-tool control sink delegate is required");
  let suppressionArmed = false;
  let suppressedBindingResponseId = null;
  let pendingGovernedSpeech = null;

  return (command) => {
    if (command?.type === "TOOL_RESULT") {
      if (suppressionArmed || suppressedBindingResponseId || pendingGovernedSpeech) {
        throw new Error("Gemini governed post-tool suppression cannot overlap tool results");
      }
      suppressionArmed = shouldSuppressGeminiPostToolProviderAudio(command);
      if (suppressionArmed) hooks.onArmed?.();
      return delegate(command);
    }

    if (command?.type === "PLAYBACK_BINDING" && suppressionArmed) {
      if (suppressedBindingResponseId) throw new Error("Gemini governed post-tool response already has a playback binding");
      suppressedBindingResponseId = responseId(command);
      hooks.onBindingSuppressed?.();
      return bindingContext.run(Object.freeze({ suppressProviderAudio: true }), () => delegate(command));
    }

    if (command?.type === "GOVERNED_SPEECH" && suppressionArmed) {
      if (pendingGovernedSpeech) throw new Error("Gemini governed post-tool speech is already pending");
      pendingGovernedSpeech = Object.freeze({ ...command });
      hooks.onGovernedDeferred?.();
      return true;
    }

    if (command?.type === "PLAYBACK_DRAIN" && suppressedBindingResponseId) {
      const drainResponseId = responseId(command);
      if (drainResponseId !== suppressedBindingResponseId) {
        throw new Error(`Gemini governed post-tool drain identity mismatch: expected ${suppressedBindingResponseId}`);
      }
      const governed = pendingGovernedSpeech;
      const drained = delegate(command);
      return forwardAfter(drained, () => {
        suppressionArmed = false;
        suppressedBindingResponseId = null;
        pendingGovernedSpeech = null;
        hooks.onReleasedAfterDrain?.();
        return governed ? delegate(governed) : drained;
      });
    }

    return delegate(command);
  };
}

/**
 * Installs a Gemini-only physical-playback guard. Provider audio may arrive
 * before or after the Control Plane binding; pending chunks are discarded at
 * the governed binding and later chunks stay suppressed until that empty
 * provider response drains. Normal responses retain the original behavior.
 */
export function installGeminiPostToolPlaybackSuppression(BoundPlaybackGate) {
  const prototype = BoundPlaybackGate?.prototype;
  if (!prototype || typeof prototype.bind !== "function" || typeof prototype.queue !== "function") {
    throw new Error("Gemini BoundPlaybackGate is required");
  }
  if (prototype[PATCHED]) return;

  const originalBind = prototype.bind;
  const originalQueue = prototype.queue;
  const originalFinish = prototype.finish;
  const originalReset = prototype.reset;

  prototype.bind = function guardedBind(responseIdValue, kind) {
    if (bindingContext.getStore()?.suppressProviderAudio === true) {
      this.pending = [];
      this.pendingBytes = 0;
      this[SUPPRESS_PROVIDER_AUDIO] = true;
    }
    return originalBind.call(this, responseIdValue, kind);
  };

  prototype.queue = function guardedQueue(pcm) {
    if (this[SUPPRESS_PROVIDER_AUDIO] === true) return;
    return originalQueue.call(this, pcm);
  };

  prototype.finish = function guardedFinish(responseIdValue) {
    try {
      return originalFinish.call(this, responseIdValue);
    } finally {
      if (!this.binding && !this.owner?.activeResponseId?.()) this[SUPPRESS_PROVIDER_AUDIO] = false;
    }
  };

  prototype.reset = function guardedReset() {
    this[SUPPRESS_PROVIDER_AUDIO] = false;
    return originalReset.call(this);
  };

  Object.defineProperty(prototype, PATCHED, { value: true });
}
