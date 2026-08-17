export type ConfirmedBargeInPromotionPlan = {
  cancelActiveResponse: boolean;
  clearAudioBuffer: boolean;
  waitForResponseDone: boolean;
};

/**
 * SIP may clear playback while the Realtime response is still active. Audio
 * transport state and response-generation state are therefore independent.
 * A confirmed barge-in must cancel any active response and wait for its
 * response.done before creating the caller's new response.
 */
export function planConfirmedBargeInPromotion(
  activeResponseId: string | null,
  playbackAlreadyCleared: boolean,
): ConfirmedBargeInPromotionPlan {
  const hasActiveResponse = typeof activeResponseId === "string" && activeResponseId.length > 0;
  return {
    cancelActiveResponse: hasActiveResponse,
    clearAudioBuffer: hasActiveResponse && !playbackAlreadyCleared,
    waitForResponseDone: hasActiveResponse,
  };
}
