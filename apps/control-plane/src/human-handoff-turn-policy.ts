export type HandoffTurnPolicyState = {
  turnId: number;
  resolvedTool: string | null;
  resolvedStatus: string | null;
  resolvedResponseCompleted: boolean;
};

export function initialHandoffTurnPolicyState(): HandoffTurnPolicyState {
  return {
    turnId: 0,
    resolvedTool: null,
    resolvedStatus: null,
    resolvedResponseCompleted: false,
  };
}

export function beginUserTurn(state: HandoffTurnPolicyState): HandoffTurnPolicyState {
  return {
    turnId: state.turnId + 1,
    resolvedTool: null,
    resolvedStatus: null,
    resolvedResponseCompleted: false,
  };
}

export function recordSelfServiceResult(
  state: HandoffTurnPolicyState,
  tool: string,
  status: string,
): HandoffTurnPolicyState {
  // Keep this intentionally conservative. A business-information FOUND result is
  // authoritative and directly answers menu/hours/services questions. Other
  // outcomes may still legitimately require a person and are not blocked here.
  if (tool !== "restaurant_business_info" || status !== "FOUND") return state;
  return {
    ...state,
    resolvedTool: tool,
    resolvedStatus: status,
    resolvedResponseCompleted: false,
  };
}

export function markResolvedResponseCompleted(state: HandoffTurnPolicyState): HandoffTurnPolicyState {
  if (!state.resolvedTool) return state;
  return { ...state, resolvedResponseCompleted: true };
}

export function shouldBlockHumanHandoff(state: HandoffTurnPolicyState): boolean {
  return Boolean(state.resolvedTool && state.resolvedStatus === "FOUND" && state.resolvedResponseCompleted);
}
