export type CallerTurnFragmentState = {
  activeSpeechItemId: string | null;
  deferredFragments: string[];
};

export type CallerTranscriptDecision =
  | { action: "DEFER"; next: CallerTurnFragmentState }
  | { action: "FORWARD"; transcript: string; fragmentCount: number; next: CallerTurnFragmentState };

function normalizeTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function initialCallerTurnFragmentState(): CallerTurnFragmentState {
  return { activeSpeechItemId: null, deferredFragments: [] };
}

export function observeCallerSpeechStarted(
  state: CallerTurnFragmentState,
  itemId: string | null | undefined,
): CallerTurnFragmentState {
  return {
    activeSpeechItemId: itemId?.trim() || null,
    deferredFragments: state.deferredFragments,
  };
}

/**
 * Consolidate only when the provider gives structural proof of a split turn:
 * a newer speech item started before an older transcript completed. No timers,
 * pauses or linguistic heuristics participate in this decision.
 */
export function observeCallerTranscriptCompleted(
  state: CallerTurnFragmentState,
  input: { itemId?: string | null; transcript: string },
): CallerTranscriptDecision {
  const transcript = normalizeTranscript(input.transcript);
  const itemId = input.itemId?.trim() || null;
  const newerSpeechAlreadyActive = Boolean(
    transcript && itemId && state.activeSpeechItemId && itemId !== state.activeSpeechItemId,
  );

  if (newerSpeechAlreadyActive) {
    return {
      action: "DEFER",
      next: {
        activeSpeechItemId: state.activeSpeechItemId,
        deferredFragments: [...state.deferredFragments, transcript],
      },
    };
  }

  const fragments = transcript ? [...state.deferredFragments, transcript] : [...state.deferredFragments];
  const consolidated = fragments.join(" ").replace(/\s+/g, " ").trim();
  return {
    action: "FORWARD",
    transcript: consolidated,
    fragmentCount: fragments.length,
    next: {
      activeSpeechItemId: null,
      deferredFragments: [],
    },
  };
}
