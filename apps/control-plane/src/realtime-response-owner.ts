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
  | { type: "create_caller_response" }
  | { type: "response_ownership_conflict"; previousResponseId: string; newResponseId: string };

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
 * Pure authority model for Realtime response ownership.
 *
 * Invariants:
 * - one component owns response.create/response.cancel decisions;
 * - playback state and response-generation state are independent;
 * - a confirmed interruption with an active provider response waits for correlated
 *   response.done evidence before emitting the replacement response.create;
 * - if no provider response remains active, a confirmed interruption may create
 *   the caller response immediately;
 * - callerResponsePending is one-shot authority: emitting create_caller_response
 *   consumes it immediately, so a later response.done cannot synthesize another
 *   response without new caller/tool authority;
 * - an ignored candidate is non-destructive: it never cancels the authoritative
 *   response and never synthesizes a replacement continuation;
 * - a SIP playback clear is observation about playout, not permission to replace
 *   an ignored assistant response;
 * - response.done is reconciliation evidence and only releases a pending caller
 *   response when it matches the authoritative active response identity;
 * - if Realtime reports a second response while one is still active, the newest
 *   server-created response becomes authoritative and the conflict is surfaced;
 * - a late response start cannot destroy an already-valid barge-in classification
 *   or a caller turn already waiting for provider release;
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
      const preservePendingCallerTurn = snapshot.state === "CALLER_TURN_READY" && snapshot.callerResponsePending;
      return {
        snapshot: {
          state: snapshot.state === "BARGE_IN_CLASSIFYING"
            ? "BARGE_IN_CLASSIFYING"
            : preservePendingCallerTurn
              ? "CALLER_TURN_READY"
              : "ASSISTANT_ACTIVE",
          activeResponseId: event.responseId,
          playbackCleared: snapshot.state === "BARGE_IN_CLASSIFYING" || preservePendingCallerTurn
            ? snapshot.playbackCleared
            : false,
          callerResponsePending: snapshot.callerResponsePending,
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
      return {
        snapshot: {
          ...snapshot,
          state: "ASSISTANT_ACTIVE",
          callerResponsePending: false,
        },
        effects: [],
      };

    case "barge_in_interrupt": {
      if (snapshot.state !== "BARGE_IN_CLASSIFYING") return { snapshot, effects: [] };
      const effects: ResponseOwnerEffect[] = [];
      const waitsForProviderRelease = snapshot.activeResponseId !== null;
      if (snapshot.activeResponseId) effects.push({ type: "cancel_response", responseId: snapshot.activeResponseId });
      if (!snapshot.playbackCleared) effects.push({ type: "clear_playback" });
      if (!waitsForProviderRelease) effects.push({ type: "create_caller_response" });
      return {
        snapshot: {
          ...snapshot,
          state: "CALLER_TURN_READY",
          callerResponsePending: waitsForProviderRelease,
          playbackCleared: true,
        },
        effects,
      };
    }

    case "assistant_response_done":
      if (snapshot.activeResponseId !== event.responseId) return { snapshot, effects: [] };
      if (snapshot.callerResponsePending && snapshot.state === "CALLER_TURN_READY") {
        return {
          snapshot: {
            ...snapshot,
            activeResponseId: null,
            callerResponsePending: false,
          },
          effects: [{ type: "create_caller_response" }],
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
        },
        effects: conflict,
      };
    }
  }
}
