export type SidebandLifecycleQuiescenceAction =
  | "CLEAR_PRESENCE_TIMER"
  | "CLEAR_SILENCE_CLOSE_TIMER"
  | "CLEAR_MAX_CALL_TIMER"
  | "CLEAR_PRESENCE_RESPONSE_STATE";

/**
 * Transport closure is a terminal boundary for realtime speech. Once the
 * sideband is gone, conversational deadlines must become inert: none may later
 * request speech or closing audio against a disconnected provider socket.
 *
 * This policy deliberately does not reconnect, speak, hang up, or infer a
 * semantic call outcome. It only quiesces local realtime-dependent deadlines.
 */
export function sidebandCloseQuiescenceActions(): SidebandLifecycleQuiescenceAction[] {
  return [
    "CLEAR_PRESENCE_TIMER",
    "CLEAR_SILENCE_CLOSE_TIMER",
    "CLEAR_MAX_CALL_TIMER",
    "CLEAR_PRESENCE_RESPONSE_STATE",
  ];
}
