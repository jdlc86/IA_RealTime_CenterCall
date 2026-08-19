import type { RealtimeProviderEvent } from "./realtime-provider-event.js";

export type RawVadRoute = "V40_ONLY" | "INHERITED";

/**
 * Raw VAD is only acoustic evidence. While normal assistant playback is active,
 * v40 must observe caller speech so it can enter BARGE_IN_CLASSIFYING, but the
 * same event must not reach inherited pre-v40 handlers that may clear playback
 * before semantic classification completes.
 */
export function decideRawVadRoute(
  eventType: RealtimeProviderEvent["type"] | undefined,
  normalPlaybackActive: boolean,
): RawVadRoute {
  if (eventType === "CALLER_SPEECH_STARTED" && normalPlaybackActive) return "V40_ONLY";
  return "INHERITED";
}
