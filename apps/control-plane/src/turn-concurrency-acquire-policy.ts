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
