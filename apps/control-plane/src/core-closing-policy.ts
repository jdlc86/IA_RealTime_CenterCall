import type { CoreWorkflow } from "./core-intent-machine.js";

export type ClosingDecision =
  | { action: "ALLOW_CLOSE"; pending: false }
  | { action: "ASK_CONFIRMATION"; pending: true }
  | { action: "CONTINUE"; pending: false };

function hasActiveOperationalWorkflow(workflow: CoreWorkflow): boolean {
  return workflow === "CREATE_RESERVATION"
    || workflow === "CANCEL_RESERVATION"
    || workflow === "QUERY_RESERVATION"
    || workflow === "MARKETING_CONSENT";
}

/**
 * Closing is irreversible, so while an operational workflow is active it needs
 * one explicit confirmation turn. This protects against a single classifier
 * mistake without adding guards to normal workflow execution.
 */
export function decideClosingTransition(
  currentWorkflow: CoreWorkflow,
  requestedWorkflow: CoreWorkflow,
  closingPending: boolean,
): ClosingDecision {
  if (requestedWorkflow !== "CLOSING") {
    return { action: "CONTINUE", pending: false };
  }

  if (!hasActiveOperationalWorkflow(currentWorkflow)) {
    return { action: "ALLOW_CLOSE", pending: false };
  }

  if (closingPending) {
    return { action: "ALLOW_CLOSE", pending: false };
  }

  return { action: "ASK_CONFIRMATION", pending: true };
}
