export type ResponseOwnerState =
  | "IDLE"
  | "ASSISTANT_ACTIVE"
  | "BARGE_IN_CLASSIFYING"
  | "CALLER_TURN_READY"
  | "TERMINAL";

export type ResponseOwnerEvent =
  | { type: "assistant_response_started"; responseId: string }
  | { type: "assistant_playback_cleared" }
  | { type: "caller_speech_started" }
  | { type: "barge_in_ignore" }
  | { type: "barge_in_interrupt" }
  | { type: "assistant_response_done"; responseId: string }
  | { type: "caller_response_created"; responseId: string }
  | { type: "terminal" };

export type ResponseOwnerEffect =
  | { type: "cancel_response"; responseId: string }
  | { type: "clear_playback" }
  | { type: "resume_assistant" }
  | { type: "create_caller_response" };

export type ResponseOwnerSnapshot = {
  state: ResponseOwnerState;
  activeResponseId: string | null;
  playbackCleared: boolean;
  callerResponsePending: boolean;
};

export function initialResponseOwnerSnapshot(): ResponseOwnerSnapshot {
  return {
    state: "IDLE",
    activeResponseId: null,
    playbackCleared: false,
    callerResponsePending: false,
  };
}

/**
 * Pure testbed for the next runtime design. This module is intentionally NOT
 * integrated into CallSession v39 yet.
 *
 * Invariants:
 * - one component owns response.create/response.cancel decisions;
 * - playback state and response-generation state are independent;
 * - a confirmed interruption never waits indefinitely for response.done;
 * - response.done is reconciliation evidence, not permission to continue;
 * - terminal state is absorbing.
 */
export function reduceResponseOwner(
  snapshot: ResponseOwnerSnapshot,
  event: ResponseOwnerEvent,
): { snapshot: ResponseOwnerSnapshot; effects: ResponseOwnerEffect[] } {
  if (snapshot.state === "TERMINAL") return { snapshot, effects: [] };
  if (event.type === "terminal") {
    return {
      snapshot: { ...snapshot, state: "TERMINAL", activeResponseId: null, callerResponsePending: false },
      effects: [],
    };
  }

  switch (event.type) {
    case "assistant_response_started":
      return {
        snapshot: {
          state: "ASSISTANT_ACTIVE",
          activeResponseId: event.responseId,
          playbackCleared: false,
          callerResponsePending: false,
        },
        effects: [],
      };

    case "assistant_playback_cleared":
      return { snapshot: { ...snapshot, playbackCleared: true }, effects: [] };

    case "caller_speech_started":
      if (snapshot.state !== "ASSISTANT_ACTIVE") return { snapshot, effects: [] };
      return { snapshot: { ...snapshot, state: "BARGE_IN_CLASSIFYING" }, effects: [] };

    case "barge_in_ignore":
      if (snapshot.state !== "BARGE_IN_CLASSIFYING") return { snapshot, effects: [] };
      return {
        snapshot: {
          ...snapshot,
          state: "ASSISTANT_ACTIVE",
          callerResponsePending: false,
        },
        effects: snapshot.playbackCleared ? [{ type: "resume_assistant" }] : [],
      };

    case "barge_in_interrupt": {
      if (snapshot.state !== "BARGE_IN_CLASSIFYING") return { snapshot, effects: [] };
      const effects: ResponseOwnerEffect[] = [];
      if (snapshot.activeResponseId) effects.push({ type: "cancel_response", responseId: snapshot.activeResponseId });
      if (!snapshot.playbackCleared) effects.push({ type: "clear_playback" });
      // Critical design change vs v43: caller response creation is authorized
      // immediately by the confirmed semantic decision. response.done may arrive
      // later and only reconciles the old response id.
      effects.push({ type: "create_caller_response" });
      return {
        snapshot: {
          ...snapshot,
          state: "CALLER_TURN_READY",
          callerResponsePending: true,
          playbackCleared: true,
        },
        effects,
      };
    }

    case "assistant_response_done":
      if (snapshot.activeResponseId !== event.responseId) return { snapshot, effects: [] };
      return {
        snapshot: { ...snapshot, activeResponseId: null },
        effects: [],
      };

    case "caller_response_created":
      if (!snapshot.callerResponsePending) return { snapshot, effects: [] };
      return {
        snapshot: {
          state: "ASSISTANT_ACTIVE",
          activeResponseId: event.responseId,
          playbackCleared: false,
          callerResponsePending: false,
        },
        effects: [],
      };
  }
}
