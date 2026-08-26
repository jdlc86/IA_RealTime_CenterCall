export type RejectedTurnRecovery = Readonly<{
  action: "TERMINATE_CALL" | "CLEAN_RESTART_PROVIDER";
  allowSessionResumption: false;
  requireFreshProviderConnection: true;
  reason: "TERMINAL_POLICY_REJECTION" | "UNTRUSTED_CONTEXT_ENTERED_PROVIDER";
}>;

/**
 * A rejected caller turn may already have reached Gemini Live for latency.
 * Quarantining output prevents effects, but cannot remove that input from the
 * provider context. Therefore a non-terminal rejection requires a brand-new
 * provider session from trusted state; session resumption is forbidden.
 */
export function planRejectedTurnRecovery(input: {
  terminal: boolean;
  enteredProviderContext: boolean;
}): RejectedTurnRecovery {
  if (typeof input?.terminal !== "boolean" || typeof input?.enteredProviderContext !== "boolean") {
    throw new Error("Rejected turn recovery input is invalid");
  }

  if (input.terminal) {
    return Object.freeze({
      action: "TERMINATE_CALL",
      allowSessionResumption: false,
      requireFreshProviderConnection: true,
      reason: "TERMINAL_POLICY_REJECTION",
    });
  }

  if (!input.enteredProviderContext) {
    throw new Error("Non-terminal rejected turn without provider context does not require trust recovery");
  }

  return Object.freeze({
    action: "CLEAN_RESTART_PROVIDER",
    allowSessionResumption: false,
    requireFreshProviderConnection: true,
    reason: "UNTRUSTED_CONTEXT_ENTERED_PROVIDER",
  });
}
