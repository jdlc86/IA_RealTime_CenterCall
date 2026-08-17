import {
  reduceResponseOwner,
  type ResponseOwnerEffect,
  type ResponseOwnerSnapshot,
} from "./realtime-response-owner.js";

export type BargeInSemanticDecision = "INTERRUPT" | "IGNORE";

export type BargeInDecisionResult = {
  snapshot: ResponseOwnerSnapshot;
  effects: ResponseOwnerEffect[];
  accepted: boolean;
};

/**
 * Semantic boundary between speech detection/classification and response ownership.
 *
 * Raw VAD/speech_started is never enough to authorize socket effects. Only an
 * explicit semantic decision may move the owner out of BARGE_IN_CLASSIFYING.
 */
export function applyBargeInSemanticDecision(
  snapshot: ResponseOwnerSnapshot,
  decision: BargeInSemanticDecision,
): BargeInDecisionResult {
  if (snapshot.state !== "BARGE_IN_CLASSIFYING") {
    return { snapshot, effects: [], accepted: false };
  }

  const event = decision === "INTERRUPT"
    ? { type: "barge_in_interrupt" as const }
    : { type: "barge_in_ignore" as const };

  const result = reduceResponseOwner(snapshot, event);
  return { ...result, accepted: true };
}
