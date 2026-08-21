import type { ConversationNextAction } from "./core-intent-machine.js";

export type ConversationNextActionRuntime = Readonly<{
  current(): ConversationNextAction;
  update(action: ConversationNextAction): void;
}>;

const runtimeByConversation = new WeakMap<object, ConversationNextActionRuntime>();

/**
 * Owns the structured next-action decision shared by intent routing and speech
 * policy. Consumers depend on this capability, never on a CallSession version.
 */
export function conversationNextActionRuntimeFor(conversation: object): ConversationNextActionRuntime {
  const existing = runtimeByConversation.get(conversation);
  if (existing) return existing;

  let action: ConversationNextAction = "CONTINUE_WORKFLOW";
  const runtime = Object.freeze({
    current: () => action,
    update: (next: ConversationNextAction) => { action = next; },
  });
  runtimeByConversation.set(conversation, runtime);
  return runtime;
}
