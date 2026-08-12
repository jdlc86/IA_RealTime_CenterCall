import type { SemanticDecision } from "./semantic-router";

export type ConversationLifecycleState = "active" | "ambiguous" | "closing";
export type SpecializedFlow = "RESERVATION" | "MARKETING_CONSENT" | null;

export type ConversationAuthorityContext = {
  lifecycleState: ConversationLifecycleState | string;
  hangupStarted: boolean;
  reservationInProgress: boolean;
};

export type ConversationAuthorityDecision = {
  flow: SpecializedFlow;
  reason: "CALL_TERMINAL" | "RESERVATION_OWNS_DEGRADED_TURN" | "CLASSIFIER_DECISION" | "CORE_ROUTER";
};

/**
 * Single authority for deciding whether a specialized backend workflow may consume
 * a classifier turn. The classifier proposes semantics; lifecycle/workflow state
 * decides ownership. Closing is terminal. An in-progress reservation owns degraded
 * CONTINUE turns so a classifier fallback cannot accidentally escape into an
 * unrelated business-data flow.
 */
export function authorizeSpecializedFlow(
  context: ConversationAuthorityContext,
  semantic: SemanticDecision,
): ConversationAuthorityDecision {
  if (context.hangupStarted || context.lifecycleState === "closing") {
    return { flow: null, reason: "CALL_TERMINAL" };
  }

  if (semantic.intent !== "CONTINUE") {
    return { flow: null, reason: "CORE_ROUTER" };
  }

  if (context.reservationInProgress && semantic.degraded) {
    return { flow: "RESERVATION", reason: "RESERVATION_OWNS_DEGRADED_TURN" };
  }

  if (semantic.dataRequirement === "RESERVATION") {
    return { flow: "RESERVATION", reason: "CLASSIFIER_DECISION" };
  }

  if (semantic.dataRequirement === "MARKETING_CONSENT") {
    return { flow: "MARKETING_CONSENT", reason: "CLASSIFIER_DECISION" };
  }

  return { flow: null, reason: "CORE_ROUTER" };
}
