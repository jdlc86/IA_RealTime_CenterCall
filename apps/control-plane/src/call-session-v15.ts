import { CallSession as CallSessionV14 } from "./call-session-v14";
import { applyPostBookingConversationPolicy } from "./post-booking-conversation-policy";
import {
  applyReservationOutputPolicy,
  deriveReservationOutputStage,
  isLegacyReservationContinueOutput,
  rewriteReservationClassifierOutput,
  type ReservationOutputStage,
} from "./reservation-output-policy";

const BaseConstructor = CallSessionV14 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV14.prototype as any;

/**
 * v15 is the spoken-output boundary. It keeps the already validated business
 * executors intact, but prevents Realtime from receiving an open-ended
 * reservation classifier output before the backend has decided what may be said.
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
}
