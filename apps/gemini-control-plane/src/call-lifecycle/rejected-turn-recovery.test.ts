import { describe, expect, it } from "vitest";
import { planRejectedTurnRecovery } from "./rejected-turn-recovery";

describe("rejected turn trust recovery", () => {
  it("terminates on terminal policy rejection without allowing session resumption", () => {
    expect(planRejectedTurnRecovery({ terminal: true, enteredProviderContext: true })).toEqual({
      action: "TERMINATE_CALL",
      allowSessionResumption: false,
      requireFreshProviderConnection: true,
      reason: "TERMINAL_POLICY_REJECTION",
    });
  });

  it("requires a clean provider restart when rejected content entered Gemini context", () => {
    expect(planRejectedTurnRecovery({ terminal: false, enteredProviderContext: true })).toEqual({
      action: "CLEAN_RESTART_PROVIDER",
      allowSessionResumption: false,
      requireFreshProviderConnection: true,
      reason: "UNTRUSTED_CONTEXT_ENTERED_PROVIDER",
    });
  });

  it("does not invent trust recovery when rejected content never entered provider context", () => {
    expect(() => planRejectedTurnRecovery({ terminal: false, enteredProviderContext: false }))
      .toThrow(/does not require trust recovery/);
  });
});
