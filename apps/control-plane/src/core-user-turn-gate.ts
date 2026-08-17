export type UserTurnGateState = {
  pendingUserTurn: boolean;
};

export type PresenceRecoveryContext = {
  userAudioActive: boolean;
  luciaPlaybackActive: boolean;
  toolExecutionActive: boolean;
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

/**
 * Presence recovery is only valid while the system is genuinely waiting for the
 * caller. Any live caller audio, Lucia playback, or backend/tool processing means
 * the conversation is active and a recovery prompt would create a competing turn.
 */
export function shouldDeferPresenceRecovery(context: PresenceRecoveryContext): boolean {
  return context.userAudioActive || context.luciaPlaybackActive || context.toolExecutionActive;
}
