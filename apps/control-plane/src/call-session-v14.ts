import { CallSession as CallSessionV13 } from "./call-session-v13";
import {
  armClassifierTurn,
  consumeClassifierTurn,
  initialClassifierTurnGateState,
  type ClassifierTurnGateState,
} from "./classifier-turn-gate";

const CONVERSATION_INTENT = "conversation_intent";
const BaseConstructor = CallSessionV13 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV13.prototype as any;

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

/**
 * One-shot authorization boundary for the hierarchical classifier.
 *
 * This is deliberately not a conversation lifecycle. It carries only one fact:
 * whether caller-originated speech has armed exactly one classifier result. It
 * has no timers, presence decisions, response ownership or terminal authority.
 */
export class CallSession extends BaseConstructor {
  private classifierTurnGateV14: ClassifierTurnGateState = initialClassifierTurnGateState();

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "input_audio_buffer.speech_started") {
      this.classifierTurnGateV14 = armClassifierTurn(this.classifierTurnGateV14);
      (this as any).diagnostics?.checkpoint?.("CORE_USER_TURN_ARMED", {
        source: "input_audio_buffer.speech_started",
        authority_scope: "classifier_one_shot_only",
      });
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === CONVERSATION_INTENT) {
      const decision = consumeClassifierTurn(this.classifierTurnGateV14);
      this.classifierTurnGateV14 = decision.next;
      if (!decision.allowed) {
        if (event.call_id) {
          (this as any).send({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: event.call_id,
              output: JSON.stringify({ ok: false, action: "ignored", reason: "NO_USER_TURN" }),
            },
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
