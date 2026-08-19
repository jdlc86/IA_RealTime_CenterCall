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

export function shouldBeginSemanticTurnForTranscript(
  state: SemanticTurnDecisionState,
  higherLayerOwns: boolean,
): boolean {
  return !state.turnOpen || higherLayerOwns;
}

/**
 * A syntactically malformed tool call is not an executable semantic decision.
 * Empty/omitted arguments remain valid because several public tools use an
 * empty object payload. Object JSON is required for non-empty arguments.
 */
export function shouldConsumeSemanticToolDecision(rawArguments: string | undefined): boolean {
  if (!rawArguments?.trim()) return true;
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
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
