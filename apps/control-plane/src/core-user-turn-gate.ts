export type UserTurnGateState = {
  pendingUserTurn: boolean;
};

export function initialUserTurnGateState(): UserTurnGateState {
  return { pendingUserTurn: false };
}

export function markUserTurnStarted(state: UserTurnGateState): UserTurnGateState {
  return { ...state, pendingUserTurn: true };
}

export function consumeClassifierTurn(state: UserTurnGateState): { allowed: boolean; next: UserTurnGateState } {
  if (!state.pendingUserTurn) {
    return { allowed: false, next: state };
  }
  return { allowed: true, next: { pendingUserTurn: false } };
}
