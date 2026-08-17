export type BargeInPlaybackWindowEvent =
  | { type: "response_created" }
  | { type: "playback_started"; protectedSpeech: boolean }
  | { type: "playback_stopped" }
  | { type: "terminal" };

/**
 * Pure boundary for when caller speech may be interpreted as a barge-in.
 * Response generation is not audible speech; only real, non-protected playback
 * opens the window. The window closes deterministically with playback/terminal.
 */
export function reduceBargeInPlaybackWindow(
  open: boolean,
  event: BargeInPlaybackWindowEvent,
): boolean {
  switch (event.type) {
    case "response_created":
      return open;
    case "playback_started":
      return !event.protectedSpeech;
    case "playback_stopped":
    case "terminal":
      return false;
  }
}
