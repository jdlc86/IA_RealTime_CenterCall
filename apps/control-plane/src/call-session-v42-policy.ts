export function shouldQuiesceConversationLifecycleV42(state: unknown, hangupStarted: unknown): boolean {
  return state === "closing" || hangupStarted === true;
}
