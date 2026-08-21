import { CallSession as CallSessionV13 } from "./call-session-v13";
import {
  armClassifierTurn,
  consumeClassifierTurn,
  initialClassifierTurnGateState,
  type ClassifierTurnGateState,
} from "./classifier-turn-gate";
import {
  adaptRealtimeProviderEvents,
  realtimeCommandPortFor,
} from "./realtime-provider-runtime.js";

const CONVERSATION_INTENT = "conversation_intent";
const BaseConstructor = CallSessionV13 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV13.prototype as any;

/**
 * One-shot authorization boundary for the hierarchical classifier.
 *
 * This is deliberately not a conversation lifecycle. It carries only one fact:
 * whether caller-originated speech has armed exactly one classifier result. It
 * has no timers, presence decisions, response ownership or terminal authority.
 * Provider wire translation is owned by the realtime provider runtime.
 */
export class CallSession extends BaseConstructor {
  private classifierTurnGateV14: ClassifierTurnGateState = initialClassifierTurnGateState();

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptRealtimeProviderEvents(data);

    if (providerEvents.some((event) => event.type === "CALLER_SPEECH_STARTED")) {
      this.classifierTurnGateV14 = armClassifierTurn(this.classifierTurnGateV14);
      (this as any).diagnostics?.checkpoint?.("CORE_USER_TURN_ARMED", {
        source: "provider_neutral_caller_speech_started",
        authority_scope: "classifier_one_shot_only",
      });
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    const classifierEvent = providerEvents.find(
      (event) => event.type === "SEMANTIC_TOOL_SELECTED" && event.name === CONVERSATION_INTENT,
    );
    if (classifierEvent?.type === "SEMANTIC_TOOL_SELECTED") {
      const decision = consumeClassifierTurn(this.classifierTurnGateV14);
      this.classifierTurnGateV14 = decision.next;
      if (!decision.allowed) {
        if (classifierEvent.callId) {
          realtimeCommandPortFor(this as any).submitToolResult({
            callId: classifierEvent.callId,
            toolName: classifierEvent.name,
            output: { ok: false, action: "ignored", reason: "NO_USER_TURN" },
          });
        }
        (this as any).diagnostics?.checkpoint?.("CORE_INTENT_IGNORED_NO_USER_TURN", {
          classifier: CONVERSATION_INTENT,
          state_preserved: true,
        });
        return;
      }
      (this as any).diagnostics?.checkpoint?.("CORE_USER_TURN_CLASSIFIER_CONSUMED", {
        classifier: CONVERSATION_INTENT,
      });
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
