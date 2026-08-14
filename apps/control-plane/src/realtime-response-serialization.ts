export type RealtimeResponseSerializationState = {
  waitingForResponseDone: boolean;
  pendingInstructions: string | null;
};

export function initialRealtimeResponseSerializationState(): RealtimeResponseSerializationState {
  return { waitingForResponseDone: false, pendingInstructions: null };
}

export function armFunctionResponse(
  state: RealtimeResponseSerializationState,
): RealtimeResponseSerializationState {
  return { ...state, waitingForResponseDone: true };
}

export function requestSpokenResponse(
  state: RealtimeResponseSerializationState,
  instructions: string,
): {
  next: RealtimeResponseSerializationState;
  sendNow: boolean;
  replacedPending: boolean;
} {
  if (!state.waitingForResponseDone) {
    return { next: state, sendNow: true, replacedPending: false };
  }
  return {
    next: { ...state, pendingInstructions: instructions },
    sendNow: false,
    replacedPending: state.pendingInstructions !== null,
  };
}

export function releaseAfterResponseDone(
  state: RealtimeResponseSerializationState,
): {
  next: RealtimeResponseSerializationState;
  releasedInstructions: string | null;
} {
  if (!state.waitingForResponseDone) {
    return { next: state, releasedInstructions: null };
  }
  return {
    next: { waitingForResponseDone: false, pendingInstructions: null },
    releasedInstructions: state.pendingInstructions,
  };
}
