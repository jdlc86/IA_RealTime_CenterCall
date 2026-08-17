export type ConversationState =
  | "WAITING_FOR_CALLER"
  | "CALLER_SPEAKING"
  | "PROCESSING_CALLER_TURN"
  | "LUCIA_SPEAKING"
  | "CLOSING"
  | "CLOSED";

export type InputDisposition =
  | "NONE"
  | "SEMANTIC_TURN"
  | "BACKGROUND"
  | "INCOHERENT"
  | "EXPLICIT_HANDOFF"
  | "EXPLICIT_HANGUP";

export type LifecycleEvent =
  | { type: "CALL_STARTED" }
  | { type: "CALLER_SPEECH_STARTED" }
  | { type: "CALLER_TRANSCRIPT"; disposition: InputDisposition }
  | { type: "ASSISTANT_RESPONSE_STARTED" }
  | { type: "ASSISTANT_RESPONSE_FINISHED" }
  | { type: "PRESENCE_TIMEOUT" }
  | { type: "SILENCE_CLOSE_TIMEOUT" }
  | { type: "HANGUP_COMPLETED" };

export type LifecycleEffect =
  | "NONE"
  | "PROCESS_TURN"
  | "IGNORE_INPUT"
  | "ASK_PRESENCE"
  | "START_HANDOFF"
  | "START_HANGUP";

export type ConversationLifecycle = {
  state: ConversationState;
  ignoredCount: number;
  presenceChecks: number;
  terminal: boolean;
};

export function initialConversationLifecycle(): ConversationLifecycle {
  return {
    state: "WAITING_FOR_CALLER",
    ignoredCount: 0,
    presenceChecks: 0,
    terminal: false,
  };
}

export function reduceConversationLifecycle(
  current: ConversationLifecycle,
  event: LifecycleEvent,
): { next: ConversationLifecycle; effect: LifecycleEffect } {
  if (current.terminal) {
    return { next: current, effect: "NONE" };
  }

  const next = { ...current };

  switch (event.type) {
    case "CALL_STARTED":
      next.state = "WAITING_FOR_CALLER";
      return { next, effect: "NONE" };

    case "CALLER_SPEECH_STARTED":
      if (current.state !== "CLOSING" && current.state !== "CLOSED") {
        next.state = "CALLER_SPEAKING";
      }
      return { next, effect: "NONE" };

    case "CALLER_TRANSCRIPT": {
      switch (event.disposition) {
        case "BACKGROUND":
          next.state = current.state === "LUCIA_SPEAKING" ? "LUCIA_SPEAKING" : "WAITING_FOR_CALLER";
          return { next, effect: "IGNORE_INPUT" };
        case "INCOHERENT":
          next.ignoredCount = current.ignoredCount + 1;
          next.state = "WAITING_FOR_CALLER";
          return { next, effect: "IGNORE_INPUT" };
        case "EXPLICIT_HANDOFF":
          next.state = "CLOSING";
          return { next, effect: "START_HANDOFF" };
        case "EXPLICIT_HANGUP":
          next.state = "CLOSING";
          return { next, effect: "START_HANGUP" };
        case "SEMANTIC_TURN":
          next.state = "PROCESSING_CALLER_TURN";
          next.ignoredCount = 0;
          next.presenceChecks = 0;
          return { next, effect: "PROCESS_TURN" };
        case "NONE":
        default:
          next.state = "WAITING_FOR_CALLER";
          return { next, effect: "IGNORE_INPUT" };
      }
    }

    case "ASSISTANT_RESPONSE_STARTED":
      next.state = "LUCIA_SPEAKING";
      return { next, effect: "NONE" };

    case "ASSISTANT_RESPONSE_FINISHED":
      next.state = "WAITING_FOR_CALLER";
      return { next, effect: "NONE" };

    case "PRESENCE_TIMEOUT":
      next.presenceChecks = current.presenceChecks + 1;
      next.state = "WAITING_FOR_CALLER";
      return { next, effect: "ASK_PRESENCE" };

    case "SILENCE_CLOSE_TIMEOUT":
      next.state = "CLOSING";
      return { next, effect: "START_HANGUP" };

    case "HANGUP_COMPLETED":
      next.state = "CLOSED";
      next.terminal = true;
      return { next, effect: "NONE" };
  }
}
