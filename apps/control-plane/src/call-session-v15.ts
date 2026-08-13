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

type RealtimeEventV15 = {
  type?: string;
  transcript?: string;
};

function readRealtimeTextV15(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function normalizeClosingTextV15(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAssistantClosingCommitmentV15(raw: string): boolean {
  const text = normalizeClosingTextV15(raw);
  return [
    /\bvoy a colgar(?: la llamada)?(?: ahora)?\b/,
    /\bvoy a finalizar(?: la llamada)?(?: ahora)?\b/,
    /\bvoy a terminar(?: la llamada)?(?: ahora)?\b/,
    /\bprocedo a colgar(?: la llamada)?\b/,
    /\bprocedo a finalizar(?: la llamada)?\b/,
    /\bterminare la llamada(?: ahora)?\b/,
    /\bfinalizare la llamada(?: ahora)?\b/,
    /\bcolgare(?: la llamada)?(?: ahora)?\b/,
  ].some((pattern) => pattern.test(text));
}

/**
 * v15 is the final spoken-output boundary. Business executors remain unchanged.
 * It gates reservation speech on backend state and also enforces that only the
 * Core state machine owns call termination: assistant wording is never authority.
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
    const text = readRealtimeTextV15(data);
    let event: RealtimeEventV15 | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEventV15; } catch { event = null; }
    }

    if (
      event?.type === "response.output_audio_transcript.done"
      && typeof event.transcript === "string"
      && (this as any).state !== "closing"
      && isAssistantClosingCommitmentV15(event.transcript)
    ) {
      (this as any).diagnostics?.fail?.("ASSISTANT_CLOSING_COMMITMENT_BLOCKED_BY_CORE", "ASSISTANT_WORDING_IS_NOT_CLOSE_AUTHORITY", {
        state_preserved: String((this as any).state ?? "active"),
        core_close_required: true,
      });
      BasePrototype.createSpokenResponse.call(
        this,
        "No termines ni anuncies que vas a terminar la llamada. El cierre todavía no está autorizado por la máquina de estados. Pregunta de forma natural si necesita algo más en lo que puedas ayudar y espera su respuesta.",
      );
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
