import type { GeminiControlEnvelopeV1 } from "../control-contract/v1";

export type GeminiCallPhase =
  | "CALL_BOOTSTRAP"
  | "LISTENING"
  | "CALLER_ACTIVE"
  | "TURN_GATING"
  | "RECOVERING"
  | "CLOSING"
  | "TERMINAL";

export type GeminiCallLifecycleState = Readonly<{
  phase: GeminiCallPhase;
  activeTurnId: string | null;
  providerConnectionEpoch: number | null;
  mediaStarted: boolean;
}>;

export type GeminiCallLifecycleDecision =
  | Readonly<{ action: "APPLY"; state: GeminiCallLifecycleState }>
  | Readonly<{ action: "ACCEPT_NO_EFFECT"; state: GeminiCallLifecycleState }>
  | Readonly<{ action: "INVALID_STATE"; reason: string; state: GeminiCallLifecycleState }>;

export const INITIAL_GEMINI_CALL_LIFECYCLE_STATE: GeminiCallLifecycleState = Object.freeze({
  phase: "CALL_BOOTSTRAP",
  activeTurnId: null,
  providerConnectionEpoch: null,
  mediaStarted: false,
});

function stringPayload(envelope: GeminiControlEnvelopeV1, key: string): string {
  const value = envelope.payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Lifecycle payload ${key} is invalid`);
  return value.trim();
}

function integerPayload(envelope: GeminiControlEnvelopeV1, key: string): number {
  const value = envelope.payload[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Lifecycle payload ${key} is invalid`);
  }
  return value;
}

function invalid(state: GeminiCallLifecycleState, reason: string): GeminiCallLifecycleDecision {
  return Object.freeze({ action: "INVALID_STATE", reason, state });
}

function applied(state: GeminiCallLifecycleState): GeminiCallLifecycleDecision {
  return Object.freeze({ action: "APPLY", state: Object.freeze(state) });
}

function noEffect(state: GeminiCallLifecycleState): GeminiCallLifecycleDecision {
  return Object.freeze({ action: "ACCEPT_NO_EFFECT", state });
}

/**
 * Minimal provider-specific lifecycle for the independent Gemini product.
 * This reducer intentionally covers only admission/media/caller/recovery
 * boundaries proven in Phase 2. Tool and assistant generation ownership are
 * added as later slices instead of importing the historical CallSession chain.
 */
export function reduceGeminiCallLifecycle(
  state: GeminiCallLifecycleState,
  envelope: GeminiControlEnvelopeV1,
): GeminiCallLifecycleDecision {
  if (state.phase === "TERMINAL") {
    if (envelope.type === "ACK" || envelope.type === "NACK" || envelope.type === "SYNC") return noEffect(state);
    return invalid(state, "TERMINAL_IS_ABSORBING");
  }

  switch (envelope.type) {
    case "ACK":
    case "NACK":
    case "SYNC":
    case "SESSION_RESUMPTION_UPDATE":
    case "PROVIDER_GO_AWAY":
      return noEffect(state);

    case "EDGE_READY": {
      if (state.phase !== "CALL_BOOTSTRAP" && state.phase !== "RECOVERING") {
        return invalid(state, "EDGE_READY_REQUIRES_BOOTSTRAP_OR_RECOVERING");
      }
      const epoch = integerPayload(envelope, "provider_connection_epoch");
      if (state.providerConnectionEpoch !== null && epoch <= state.providerConnectionEpoch) {
        return invalid(state, "PROVIDER_EPOCH_MUST_INCREASE");
      }
      return applied({ ...state, providerConnectionEpoch: epoch });
    }

    case "MEDIA_STARTED": {
      if (state.phase !== "CALL_BOOTSTRAP" || state.providerConnectionEpoch === null || state.mediaStarted) {
        return invalid(state, "MEDIA_STARTED_REQUIRES_READY_BOOTSTRAP");
      }
      return applied({ ...state, phase: "LISTENING", mediaStarted: true });
    }

    case "CALLER_ACTIVITY_STARTED": {
      if (state.phase !== "LISTENING" || !state.mediaStarted || state.activeTurnId !== null) {
        return invalid(state, "CALLER_ACTIVITY_STARTED_REQUIRES_LISTENING");
      }
      return applied({ ...state, phase: "CALLER_ACTIVE", activeTurnId: stringPayload(envelope, "turn_id") });
    }

    case "CALLER_ACTIVITY_ENDED": {
      const turnId = stringPayload(envelope, "turn_id");
      if (state.phase !== "CALLER_ACTIVE" || state.activeTurnId !== turnId) {
        return invalid(state, "CALLER_ACTIVITY_ENDED_REQUIRES_ACTIVE_TURN");
      }
      return applied({ ...state, phase: "TURN_GATING" });
    }

    case "CALLER_TRANSCRIPT_READY": {
      const turnId = stringPayload(envelope, "turn_id");
      if (state.phase !== "TURN_GATING" || state.activeTurnId !== turnId) {
        return invalid(state, "CALLER_TRANSCRIPT_READY_REQUIRES_GATING_TURN");
      }
      return noEffect(state);
    }

    case "PROVIDER_RECONNECTED": {
      if (state.phase !== "RECOVERING") {
        return invalid(state, "PROVIDER_RECONNECTED_REQUIRES_RECOVERING");
      }
      if (envelope.payload.mode !== "CLEAN_RESTART") {
        return invalid(state, "TRUST_RECOVERY_REQUIRES_CLEAN_RESTART");
      }
      const epoch = integerPayload(envelope, "provider_connection_epoch");
      if (state.providerConnectionEpoch !== null && epoch <= state.providerConnectionEpoch) {
        return invalid(state, "PROVIDER_EPOCH_MUST_INCREASE");
      }
      return applied({
        phase: "LISTENING",
        activeTurnId: null,
        providerConnectionEpoch: epoch,
        mediaStarted: state.mediaStarted,
      });
    }

    case "MEDIA_CLOSED":
      return applied({ ...state, phase: "TERMINAL", activeTurnId: null, mediaStarted: false });

    case "EDGE_ERROR":
      if (envelope.payload.terminal === true) {
        return applied({ ...state, phase: "TERMINAL", activeTurnId: null, mediaStarted: false });
      }
      return applied({ ...state, phase: "RECOVERING", activeTurnId: null });

    // Generation/tool/playback events require their own owners and are not
    // admitted into lifecycle state until those slices are implemented.
    case "GEMINI_TOOL_CALL":
    case "GEMINI_GENERATION_STARTED":
    case "GEMINI_INTERRUPTED":
    case "GEMINI_GENERATION_COMPLETE":
    case "GEMINI_TURN_COMPLETE":
    case "PLAYBACK_STARTED":
    case "PLAYBACK_COMPLETED":
      return invalid(state, "EVENT_OWNER_NOT_IMPLEMENTED");

    // Worker-originating commands should already have been rejected by the
    // direction boundary. Keeping them invalid here is defense in depth.
    case "TURN_AUTHORIZED":
    case "TURN_REJECTED":
    case "TOOL_RESULT":
    case "TOOL_REJECTED":
    case "CLEAR_PLAYBACK":
    case "SET_PROTECTED_INPUT":
    case "START_CONTROL_TURN":
    case "TERMINATE_MEDIA":
      return invalid(state, "WORKER_COMMAND_CANNOT_ENTER_EDGE_LIFECYCLE");

    default: {
      const exhaustive: never = envelope.type;
      return exhaustive;
    }
  }
}

export function enterGeminiTrustRecovery(
  state: GeminiCallLifecycleState,
): GeminiCallLifecycleState {
  if (state.phase === "TERMINAL") throw new Error("Terminal lifecycle cannot enter trust recovery");
  return Object.freeze({ ...state, phase: "RECOVERING", activeTurnId: null });
}
