export type RawVadRoute = "V40_ONLY" | "INHERITED";

/**
 * Raw VAD is only acoustic evidence. While normal assistant playback is active,
 * v40 must observe speech_started so it can enter BARGE_IN_CLASSIFYING, but the
 * same event must not reach inherited pre-v40 handlers that may treat raw VAD as
 * authority to clear playback before semantic classification completes.
 */
export function decideRawVadRoute(eventType: string | undefined, normalPlaybackActive: boolean): RawVadRoute {
  if (eventType === "input_audio_buffer.speech_started" && normalPlaybackActive) return "V40_ONLY";
  return "INHERITED";
}
