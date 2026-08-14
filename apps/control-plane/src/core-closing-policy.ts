import type { CoreWorkflow } from "./core-intent-machine.js";

export type ClosingDecision =
  | { action: "ALLOW_CLOSE"; pending: false }
  | { action: "ASK_CONFIRMATION"; pending: true }
  | { action: "CONTINUE"; pending: false };

/**
 * A semantic CLOSING decision is model-derived and the transition is irreversible.
 * Therefore an unconfirmed closing request still requires one explicit confirmation.
 *
 * The structured conversation contract may mark a turn as explicitly confirmed
 * only when the user directly answers a prior continuation/closing question with
 * an unequivocal end-of-call response. That pair (CLOSING + explicit confirmation)
 * is enough to close without asking a redundant second question.
 */
export function decideClosingTransition(
  _currentWorkflow: CoreWorkflow,
  requestedWorkflow: CoreWorkflow,
  closingPending: boolean,
  explicitClosingConfirmed = false,
): ClosingDecision {
  if (requestedWorkflow !== "CLOSING") {
    return { action: "CONTINUE", pending: false };
  }

  if (explicitClosingConfirmed || closingPending) {
    return { action: "ALLOW_CLOSE", pending: false };
  }

  return { action: "ASK_CONFIRMATION", pending: true };
}
