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
  | { type: "create_caller_response" }
  | { type: "response_ownership_conflict"; previousResponseId: string; newResponseId: string };

export type ResponseOwnerSnapshot = {
  state: ResponseOwnerState;
  activeResponseId: string | null;
  playbackCleared: boolean;
  callerResponsePending: boolean;
  resumeAfterActiveDone: boolean;
};

export function initialResponseOwnerSnapshot(): ResponseOwnerSnapshot {
  return {
    state: "IDLE",
    activeResponseId: null,
    playbackCleared: false,
    callerResponsePending: false,
    resumeAfterActiveDone: false,
  };
}

/**
 * Pure authority model for Realtime response ownership.
 *
 * Invariants:
 * - one component owns response.create/response.cancel decisions;
 * - playback state and response-generation state are independent;
 * - a confirmed interruption never waits indefinitely for response.done;
 * - an ignored candidate never creates a replacement while the original response is still active;
 * - if SIP already cleared playback for an ignored candidate, the now-inaudible active response
 *   is cancelled and continuation waits for its authoritative response.done before resuming;
 * - response.done is reconciliation evidence, not permission for confirmed interruption;
 * - if Realtime reports a second response while one is still active, the newest
 *   server-created response becomes authoritative and the conflict is surfaced;
 * - a late response start cannot destroy an already-valid barge-in classification;
 * - a late response.done for a superseded response can never clear the current one;
 * - terminal state is absorbing.
 */
export function reduceResponseOwner(
  snapshot: ResponseOwnerSnapshot,
  event: ResponseOwnerEvent,
): { snapshot: ResponseOwnerSnapshot; effects: ResponseOwnerEffect[] } {
  if (snapshot.state === "TERMINAL") return { snapshot, effects: [] };
  if (event.type === "terminal") {
    return {
      snapshot: {
        ...snapshot,
        state: "TERMINAL",
        activeResponseId: null,
        callerResponsePending: false,
        resumeAfterActiveDone: false,
      },
      effects: [],
    };
  }

  switch (event.type) {
    case "assistant_response_started": {
      const conflict = snapshot.activeResponseId && snapshot.activeResponseId !== event.responseId
        ? [{
            type: "response_ownership_conflict" as const,
            previousResponseId: snapshot.activeResponseId,
            newResponseId: event.responseId,
          }]
        : [];
      return {
        snapshot: {
          state: snapshot.state === "BARGE_IN_CLASSIFYING" ? "BARGE_IN_CLASSIFYING" : "ASSISTANT_ACTIVE",
          activeResponseId: event.responseId,
          playbackCleared: snapshot.state === "BARGE_IN_CLASSIFYING" ? snapshot.playbackCleared : false,
          callerResponsePending: false,
          resumeAfterActiveDone: snapshot.resumeAfterActiveDone,
        },
        effects: conflict,
      };
    }

    case "assistant_playback_cleared":
      return { snapshot: { ...snapshot, playbackCleared: true }, effects: [] };

    case "caller_speech_started":
      if (snapshot.state !== "ASSISTANT_ACTIVE") return { snapshot, effects: [] };
      return { snapshot: { ...snapshot, state: "BARGE_IN_CLASSIFYING" }, effects: [] };

    case "barge_in_ignore":
      if (snapshot.state !== "BARGE_IN_CLASSIFYING") return { snapshot, effects: [] };
      if (!snapshot.playbackCleared) {
        return {
          snapshot: {
            ...snapshot,
            state: "ASSISTANT_ACTIVE",
            callerResponsePending: false,
            resumeAfterActiveDone: false,
          },
          effects: [],
        };
      }
      if (snapshot.activeResponseId) {
        return {
          snapshot: {
            ...snapshot,
            state: "ASSISTANT_ACTIVE",
            callerResponsePending: false,
            resumeAfterActiveDone: true,
          },
          effects: [{ type: "cancel_response", responseId: snapshot.activeResponseId }],
        };
      }
      return {
        snapshot: {
          ...snapshot,
          state: "ASSISTANT_ACTIVE",
          callerResponsePending: false,
          playbackCleared: false,
          resumeAfterActiveDone: false,
        },
        effects: [{ type: "resume_assistant" }],
      };

    case "barge_in_interrupt": {
      if (snapshot.state !== "BARGE_IN_CLASSIFYING") return { snapshot, effects: [] };
      const effects: ResponseOwnerEffect[] = [];
      if (snapshot.activeResponseId) effects.push({ type: "cancel_response", responseId: snapshot.activeResponseId });
      if (!snapshot.playbackCleared) effects.push({ type: "clear_playback" });
      effects.push({ type: "create_caller_response" });
      return {
        snapshot: {
          ...snapshot,
          state: "CALLER_TURN_READY",
          callerResponsePending: true,
          playbackCleared: true,
          resumeAfterActiveDone: false,
        },
        effects,
      };
    }

    case "assistant_response_done":
      if (snapshot.activeResponseId !== event.responseId) return { snapshot, effects: [] };
      if (snapshot.resumeAfterActiveDone) {
        return {
          snapshot: {
            ...snapshot,
            activeResponseId: null,
            playbackCleared: false,
            resumeAfterActiveDone: false,
          },
          effects: [{ type: "resume_assistant" }],
        };
      }
      return {
        snapshot: { ...snapshot, activeResponseId: null },
        effects: [],
      };

    case "caller_response_created": {
      const conflict = snapshot.activeResponseId && snapshot.activeResponseId !== event.responseId
        ? [{
            type: "response_ownership_conflict" as const,
            previousResponseId: snapshot.activeResponseId,
            newResponseId: event.responseId,
          }]
        : [];
      return {
        snapshot: {
          state: "ASSISTANT_ACTIVE",
          activeResponseId: event.responseId,
          playbackCleared: false,
          callerResponsePending: false,
          resumeAfterActiveDone: false,
        },
        effects: conflict,
      };
    }
  }
}
