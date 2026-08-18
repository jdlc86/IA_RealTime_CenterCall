export type TurnConcurrencyAcquireInput = {
  usableTranscript: boolean;
  normalPlaybackActive: boolean;
  higherLayerOwns: boolean;
};

export type TurnConcurrencyAcquireDecision =
  | "ACQUIRE"
  | "BYPASS_UNUSABLE"
  | "BYPASS_HIGHER_LAYER"
  | "BYPASS_PLAYBACK_ALREADY_STARTED";

export type TurnConcurrencyReleaseReason =
  | "normal_assistant_playback_started"
  | "protected_playback_completed"
  | "watchdog"
  | string;

/**
 * Pure acquisition boundary for v36 semantic serialization.
 *
 * A completed transcript can arrive after the assistant has already started
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
  if (input.normalPlaybackActive) return "BYPASS_PLAYBACK_ALREADY_STARTED";
  return "ACQUIRE";
}

/**
 * Releasing semantic serialization at the exact moment normal assistant audio
 * becomes audible must preserve newly arriving caller audio. Clearing the input
 * buffer at that boundary creates a blind spot for an immediate barge-in: the
 * caller may already be speaking before non-interrupting listening is restored.
 *
 * Recovery-style releases can still discard buffered audio because their goal
 * is to abandon stale input rather than transition into an interruptible turn.
 */
export function shouldClearInputOnTurnConcurrencyRelease(
  reason: TurnConcurrencyReleaseReason,
): boolean {
  return reason !== "normal_assistant_playback_started";
}

/**
 * v36 owns semantic serialization, not playback barge-in input policy.
 *
 * On normal assistant playback the higher v40 response owner is responsible
 * for establishing non-interrupting VAD (VAD events on, provider auto-response
 * and auto-interrupt off). v36 must only release its semantic lock and must not
 * race v40 with a competing restoreInputDetection() session.update.
 *
 * Protected/recovery/watchdog releases have no v40 normal-playback owner, so
 * v36 still restores ordinary tenant input detection there.
 */
export function shouldRestoreInputDetectionOnTurnConcurrencyRelease(
  reason: TurnConcurrencyReleaseReason,
): boolean {
  return reason !== "normal_assistant_playback_started";
}
