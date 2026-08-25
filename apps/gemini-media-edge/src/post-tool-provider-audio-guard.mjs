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

/**
 * Marks exactly the provider response that follows a governed tool result. The
 * marker is carried only across the synchronous PLAYBACK_BINDING command into
 * the physical playback owner; it is never global per response id.
 */
export function createGeminiPostToolControlSink(delegate, hooks = {}) {
  if (typeof delegate !== "function") throw new Error("Gemini post-tool control sink delegate is required");
  let suppressNextBinding = false;

  return (command) => {
    if (command?.type === "TOOL_RESULT") {
      suppressNextBinding = shouldSuppressGeminiPostToolProviderAudio(command);
      if (suppressNextBinding) hooks.onArmed?.();
      return delegate(command);
    }

    if (command?.type === "GOVERNED_SPEECH") {
      if (suppressNextBinding) hooks.onReleasedWithoutBinding?.();
      suppressNextBinding = false;
      return delegate(command);
    }

    if (command?.type === "PLAYBACK_BINDING" && suppressNextBinding) {
      suppressNextBinding = false;
      hooks.onBindingSuppressed?.();
      return bindingContext.run(Object.freeze({ suppressProviderAudio: true }), () => delegate(command));
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

  prototype.bind = function guardedBind(responseId, kind) {
    if (bindingContext.getStore()?.suppressProviderAudio === true) {
      this.pending = [];
      this.pendingBytes = 0;
      this[SUPPRESS_PROVIDER_AUDIO] = true;
    }
    return originalBind.call(this, responseId, kind);
  };

  prototype.queue = function guardedQueue(pcm) {
    if (this[SUPPRESS_PROVIDER_AUDIO] === true) return;
    return originalQueue.call(this, pcm);
  };

  prototype.finish = function guardedFinish(responseId) {
    try {
      return originalFinish.call(this, responseId);
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
