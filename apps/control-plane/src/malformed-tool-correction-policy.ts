export type MalformedToolCorrectionState = Readonly<{
  pendingMalformedTool: string | null;
  recoveryRequired: boolean;
  recoveryPlaybackCompleted: boolean;
  postRecoveryCallerSpeechObserved: boolean;
}>;

export type MalformedToolCorrectionAction =
  | "PASS_TO_V29"
  | "PASS_INVALID_WITHOUT_CONSUMING"
  | "PASS_VALID_CORRECTION_TO_V29"
  | "REJECT_CROSS_TOOL_CORRECTION";

export type MalformedToolCorrectionDecision = Readonly<{
  action: MalformedToolCorrectionAction;
  next: MalformedToolCorrectionState;
}>;

export function initialMalformedToolCorrectionState(): MalformedToolCorrectionState {
  return {
    pendingMalformedTool: null,
    recoveryRequired: false,
    recoveryPlaybackCompleted: false,
    postRecoveryCallerSpeechObserved: false,
  };
}

function argumentsAreSyntacticallyValid(rawArguments: string | undefined): boolean {
  if (!rawArguments?.trim()) return true;
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function requireRecovery(state: MalformedToolCorrectionState): MalformedToolCorrectionState {
  return {
    ...state,
    recoveryRequired: true,
    recoveryPlaybackCompleted: false,
    postRecoveryCallerSpeechObserved: false,
  };
}

export function observeMalformedToolRecoveryPlaybackCompleted(
  state: MalformedToolCorrectionState,
): MalformedToolCorrectionState {
  if (!state.recoveryRequired || !state.pendingMalformedTool) return state;
  return { ...state, recoveryPlaybackCompleted: true, postRecoveryCallerSpeechObserved: false };
}

export function observeCallerSpeechAfterMalformedRecovery(
  state: MalformedToolCorrectionState,
): MalformedToolCorrectionState {
  if (!state.recoveryRequired || !state.recoveryPlaybackCompleted || !state.pendingMalformedTool) return state;
  return { ...state, postRecoveryCallerSpeechObserved: true };
}

export function observeCallerTranscriptAfterMalformedRecovery(
  state: MalformedToolCorrectionState,
): MalformedToolCorrectionState {
  if (
    !state.recoveryRequired ||
    !state.recoveryPlaybackCompleted ||
    !state.postRecoveryCallerSpeechObserved ||
    !state.pendingMalformedTool
  ) return state;
  return initialMalformedToolCorrectionState();
}

/**
 * Cross-layer contract between malformed argument handling and V29's single
 * semantic decision authority.
 *
 * A malformed payload is not executable and therefore cannot consume V29's
 * slot. It does establish same-intervention tool affinity: only that tool may
 * repair its serialization. A different tool is blocked until V51's isolated
 * recovery has fully played and fresh caller speech plus its completed
 * transcript provide an explicit conversational boundary. No timing heuristic
 * is used, so late/split transcripts cannot silently reset this authority.
 */
export function decideMalformedToolCorrection(
  state: MalformedToolCorrectionState,
  tool: string,
  rawArguments: string | undefined,
): MalformedToolCorrectionDecision {
  const valid = argumentsAreSyntacticallyValid(rawArguments);

  if (!valid) {
    if (state.pendingMalformedTool && state.pendingMalformedTool !== tool) {
      return { action: "REJECT_CROSS_TOOL_CORRECTION", next: requireRecovery(state) };
    }
    return {
      action: "PASS_INVALID_WITHOUT_CONSUMING",
      next: state.pendingMalformedTool
        ? state
        : { ...state, pendingMalformedTool: tool },
    };
  }

  if (!state.pendingMalformedTool) {
    return { action: "PASS_TO_V29", next: state };
  }

  if (state.pendingMalformedTool !== tool) {
    return { action: "REJECT_CROSS_TOOL_CORRECTION", next: requireRecovery(state) };
  }

  return {
    action: "PASS_VALID_CORRECTION_TO_V29",
    next: initialMalformedToolCorrectionState(),
  };
}
