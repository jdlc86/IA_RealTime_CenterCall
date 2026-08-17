export type SemanticTurnDecisionState = {
  turnOpen: boolean;
  decisionTaken: boolean;
  selectedTool: string | null;
};

export function initialSemanticTurnDecisionState(): SemanticTurnDecisionState {
  return { turnOpen: false, decisionTaken: false, selectedTool: null };
}

export function beginSemanticCallerTurn(): SemanticTurnDecisionState {
  return { turnOpen: true, decisionTaken: false, selectedTool: null };
}

export function selectSemanticTool(
  state: SemanticTurnDecisionState,
  tool: string,
): { next: SemanticTurnDecisionState; allowed: boolean; duplicateOf: string | null } {
  if (!state.turnOpen) {
    return {
      next: { turnOpen: true, decisionTaken: true, selectedTool: tool },
      allowed: true,
      duplicateOf: null,
    };
  }
  if (state.decisionTaken) {
    return { next: state, allowed: false, duplicateOf: state.selectedTool };
  }
  return {
    next: { ...state, decisionTaken: true, selectedTool: tool },
    allowed: true,
    duplicateOf: null,
  };
}

export function shouldArmSemanticGateAfterTranscript(state: SemanticTurnDecisionState): boolean {
  return state.turnOpen && !state.decisionTaken;
}
