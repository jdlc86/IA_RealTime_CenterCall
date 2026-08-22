export type TurnConcurrencyAcquireInput = {
  usableTranscript: boolean;
  normalPlaybackActive: boolean;
  higherLayerOwns: boolean;
  newerCallerSpeechObserved: boolean;
};

export type TurnConcurrencyAcquireDecision =
  | "ACQUIRE"
  | "BYPASS_UNUSABLE"
  | "BYPASS_HIGHER_LAYER"
  | "BYPASS_NEWER_CALLER_SPEECH"
  | "BYPASS_PLAYBACK_ALREADY_STARTED";

export type TurnConcurrencyReleaseReason =
  | "normal_assistant_playback_started"
  | "protected_playback_completed"
  | "watchdog"
  | string;

/**
 * Pure acquisition boundary for v36 semantic serialization.
 *
 * A completed transcript can arrive after a newer caller speech item has already
 * started. In that case the older transcript is not the authoritative boundary
 * for the human intervention and must not suspend input detection before the
 * newer item completes. This is event-order based; no timing heuristic is used.
 *
 * A completed transcript can also arrive after the assistant has already started
 * normal playback for that same turn. At that point acquiring a lock would
 * suspend input detection after the release boundary has already passed,
 * leaving the lock stranded until the watchdog. Playback start therefore wins
 * over a late transcript and no new v36 ownership may be acquired.
 */
export function decideTurnConcurrencyAcquire(
  input: TurnConcurrencyAcquireInput,
): TurnConcurrencyAcquireDecision {
  if (input.higherLayerOwns) return "BYPASS_HIGHER_LAYER";
  if (!input.usableTranscript) return "BYPASS_UNUSABLE";
  if (input.newerCallerSpeechObserved) return "BYPASS_NEWER_CALLER_SPEECH";
  if (input.normalPlaybackActive) return "BYPASS_PLAYBACK_ALREADY_STARTED";
  return "ACQUIRE";
}

export function shouldClearInputOnTurnConcurrencyRelease(
  reason: TurnConcurrencyReleaseReason,
): boolean {
  return reason !== "normal_assistant_playback_started";
}

export function shouldRestoreInputDetectionOnTurnConcurrencyRelease(
  reason: TurnConcurrencyReleaseReason,
): boolean {
  return reason !== "normal_assistant_playback_started";
}
