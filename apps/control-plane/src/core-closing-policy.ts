import type { CoreWorkflow } from "./core-intent-machine.js";

export type ClosingDecision =
  | { action: "ALLOW_CLOSE"; pending: false }
  | { action: "ASK_CONFIRMATION"; pending: true }
  | { action: "CONTINUE"; pending: false };

/**
 * A semantic CLOSING decision is model-derived and the transition is irreversible.
 * Therefore one classifier decision is never sufficient to terminate a call.
 *
 * First CLOSING -> ask the user for explicit confirmation and preserve state.
 * Second consecutive CLOSING -> allow terminal transition.
 * Any other intent -> clear the pending close request.
 *
 * A physical caller hangup bypasses this policy naturally.
 */
export function decideClosingTransition(
  _currentWorkflow: CoreWorkflow,
  requestedWorkflow: CoreWorkflow,
  closingPending: boolean,
): ClosingDecision {
  if (requestedWorkflow !== "CLOSING") {
    return { action: "CONTINUE", pending: false };
  }

  if (closingPending) {
    return { action: "ALLOW_CLOSE", pending: false };
  }

  return { action: "ASK_CONFIRMATION", pending: true };
}
