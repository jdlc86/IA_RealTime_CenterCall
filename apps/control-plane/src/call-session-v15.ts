import { CallSession as CallSessionV14 } from "./call-session-v14";
import { applyPostBookingConversationPolicy } from "./post-booking-conversation-policy";
import {
  applyReservationOutputPolicy,
  deriveReservationOutputStage,
  isLegacyReservationContinueOutput,
  rewriteReservationClassifierOutput,
  type ReservationOutputStage,
} from "./reservation-output-policy";
import { parseCoreIntentRequest } from "./core-intent-router";

const BaseConstructor = CallSessionV14 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV14.prototype as any;
const CONVERSATION_INTENT = "conversation_intent";

type RealtimeEvent = { type?: string; name?: string; call_id?: string; arguments?: string; };

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

/**
 * v15 is the final conversation boundary. It keeps validated business executors
 * intact while enforcing backend-authoritative reservation speech and domain scope.
 */
export class CallSession extends BaseConstructor {
  private pendingReservationClassifierOutputsV15: unknown[] = [];

  private send(data: unknown): void {
    if (isLegacyReservationContinueOutput(data)) {
      this.pendingReservationClassifierOutputsV15.push(data);
      (this as any).diagnostics?.checkpoint?.("RESERVATION_CLASSIFIER_OUTPUT_DEFERRED", {
        reason: "await_backend_conversation_stage",
        pending_count: this.pendingReservationClassifierOutputsV15.length,
      });
      return;
    }
    BasePrototype.send.call(this, data);
  }

  private flushReservationClassifierOutputs(stage: ReservationOutputStage): void {
    if (!this.pendingReservationClassifierOutputsV15.length) return;
    const pending = this.pendingReservationClassifierOutputsV15.splice(0);
    for (const output of pending) {
      BasePrototype.send.call(this, rewriteReservationClassifierOutput(output, stage));
    }
    (this as any).diagnostics?.checkpoint?.("RESERVATION_CLASSIFIER_OUTPUT_RELEASED", {
      stage,
      released_count: pending.length,
    });
  }

  private createSpokenResponse(instructions: string): void {
    let governed = applyPostBookingConversationPolicy(instructions);
    if (governed !== instructions) {
      (this as any).diagnostics?.checkpoint?.("POST_BOOKING_PROACTIVE_PROMPT_APPLIED", {
        proactive_next_intent: true,
        deferred_marketing_language_forbidden: true,
      });
    }

    if (this.pendingReservationClassifierOutputsV15.length > 0) {
      const stage = deriveReservationOutputStage({
        booked: (this as any).reservationBookedThisCall === true,
        confirmationArmed: typeof (this as any).reservationConfirmationFingerprint === "string"
          && (this as any).reservationConfirmationFingerprint.length > 0,
        instructions: governed,
      });
      governed = applyReservationOutputPolicy(governed, stage);
      this.flushReservationClassifierOutputs(stage);
      (this as any).diagnostics?.checkpoint?.("RESERVATION_CONVERSATION_STAGE_APPLIED", {
        stage,
        backend_authoritative: true,
      });
    }

    BasePrototype.createSpokenResponse.call(this, governed);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === CONVERSATION_INTENT) {
      try {
        const request = parseCoreIntentRequest(event.arguments);
        if (request.intent === "OUT_OF_SCOPE") {
          if (event.call_id) {
            BasePrototype.send.call(this, {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: event.call_id,
                output: JSON.stringify({ ok: true, action: "out_of_scope", tool_execution: false }),
              },
            });
          }
          (this as any).diagnostics?.checkpoint?.("CORE_OUT_OF_SCOPE_REJECTED", {
            tool_execution: false,
            business_info_execution: false,
            state_preserved: true,
          });
          BasePrototype.createSpokenResponse.call(
            this,
            "La petición está fuera del ámbito del negocio. No uses conocimiento general, no ejecutes herramientas y no intentes responder al contenido. Di brevemente: Solo puedo ayudarte con cuestiones relacionadas con el restaurante. ¿Necesitas algo más en lo que pueda ayudarte?",
          );
          return;
        }
      } catch {
        // Let the existing Core parser own invalid classifier payload recovery.
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
