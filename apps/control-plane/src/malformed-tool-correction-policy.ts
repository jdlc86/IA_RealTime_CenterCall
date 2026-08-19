export type MalformedToolCorrectionState = Readonly<{
  pendingMalformedTool: string | null;
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
  return { pendingMalformedTool: null };
}

export function observeCallerTurnStarted(
  _state: MalformedToolCorrectionState,
): MalformedToolCorrectionState {
  return initialMalformedToolCorrectionState();
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

/**
 * Cross-layer contract between malformed argument handling and V29's single
 * semantic decision authority.
 *
 * A malformed payload is not executable and therefore cannot consume the V29
 * slot. However, it still establishes tool affinity for the current caller turn:
 * only the same tool may repair its serialization. A different valid tool must
 * wait for fresh caller evidence instead of silently replacing the malformed
 * semantic choice.
 */
export function decideMalformedToolCorrection(
  state: MalformedToolCorrectionState,
  tool: string,
  rawArguments: string | undefined,
): MalformedToolCorrectionDecision {
  const valid = argumentsAreSyntacticallyValid(rawArguments);

  if (!valid) {
    if (state.pendingMalformedTool && state.pendingMalformedTool !== tool) {
      return { action: "REJECT_CROSS_TOOL_CORRECTION", next: state };
    }
    return {
      action: "PASS_INVALID_WITHOUT_CONSUMING",
      next: { pendingMalformedTool: tool },
    };
  }

  if (!state.pendingMalformedTool) {
    return { action: "PASS_TO_V29", next: state };
  }

  if (state.pendingMalformedTool !== tool) {
    return { action: "REJECT_CROSS_TOOL_CORRECTION", next: state };
  }

  return {
    action: "PASS_VALID_CORRECTION_TO_V29",
    next: initialMalformedToolCorrectionState(),
  };
}
