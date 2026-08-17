export type ClassifierTurnGateState = {
  pendingCallerTurn: boolean;
};

export function initialClassifierTurnGateState(): ClassifierTurnGateState {
  return { pendingCallerTurn: false };
}

export function armClassifierTurn(state: ClassifierTurnGateState): ClassifierTurnGateState {
  return state.pendingCallerTurn ? state : { pendingCallerTurn: true };
}

export function consumeClassifierTurn(
  state: ClassifierTurnGateState,
): { allowed: boolean; next: ClassifierTurnGateState } {
  if (!state.pendingCallerTurn) return { allowed: false, next: state };
  return { allowed: true, next: { pendingCallerTurn: false } };
}
