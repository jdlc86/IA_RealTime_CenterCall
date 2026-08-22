export type BargeInListeningOwnership = {
  responseId: string | null;
};

export type BargeInListeningClaim = {
  next: BargeInListeningOwnership;
  shouldAssertListening: boolean;
};

export function initialBargeInListeningOwnership(): BargeInListeningOwnership {
  return { responseId: null };
}

/**
 * Listening is scoped to the audible assistant response, not to the call.
 * A cleared/stopped playback invalidates the local assumption. The next
 * response must explicitly reassert non-interrupting listening.
 */
export function claimBargeInListening(
  state: BargeInListeningOwnership,
  responseId: string,
): BargeInListeningClaim {
  return {
    next: { responseId },
    shouldAssertListening: state.responseId !== responseId,
  };
}

export function invalidateBargeInListening(
  _state: BargeInListeningOwnership,
): BargeInListeningOwnership {
  return { responseId: null };
}
