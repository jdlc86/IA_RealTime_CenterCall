import { CallSession as CallSessionV3 } from "./call-session-v3";
import type { ReservationFlowArgs } from "./reservation-flow";

const MANAGE_RESERVATION = "manage_reservation";

const BaseConstructor = CallSessionV3 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV3.prototype as any;

type RealtimeOutputItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

type RealtimeTruthEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  delta?: string;
  transcript?: string;
  response?: {
    id?: string;
    status?: string;
    output?: RealtimeOutputItem[];
  };
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function normalizeSpeech(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function soundsLikeReservationConfirmed(value: string): boolean {
  const text = normalizeSpeech(value);
  const reservationWord = /\breserva(?:cion)?\b/.test(text);
  const confirmationWord = /\b(confirmad[ao]|hecha|realizada|completada|registrada|reservad[ao]|lista)\b/.test(text);
  const explicitVerb = /\b(he|hemos|queda|quedo|esta|ya esta|acabo de)\b/.test(text);
  return reservationWord && confirmationWord && explicitVerb;
}

export class CallSession extends BaseConstructor {
  private reservationBookedThisCall = false;
  private assistantTranscriptBuffer = "";
  private truthGuardRecoveryActive = false;
  private recoveredFunctionCallIds = new Set<string>();

  private async executeReservationFlow(args: ReservationFlowArgs, tenantId: string): Promise<Record<string, unknown>> {
    const result = await BasePrototype.executeReservationFlow.call(this, args, tenantId) as Record<string, unknown>;
    if (result?.stage === "BOOKED") {
      this.reservationBookedThisCall = true;
      (this as any).diagnostics?.checkpoint?.("RESERVATION_BOOKED_EVIDENCE", {
        source: "authorized_backend_result",
      });
    }
    return result;
  }

  private recoverFunctionCallFromResponseDone(event: RealtimeTruthEvent): RealtimeOutputItem | null {
    const output = event.response?.output;
    if (!Array.isArray(output)) return null;
    const item = output.find((candidate) =>
      candidate?.type === "function_call" &&
      candidate.name === MANAGE_RESERVATION &&
      typeof candidate.call_id === "string" &&
      typeof candidate.arguments === "string"
    );
    if (!item?.call_id || !item.arguments) return null;
    if (this.recoveredFunctionCallIds.has(item.call_id)) return null;
    return item;
  }

  private triggerReservationTruthCorrection(reason: string): void {
    if (this.truthGuardRecoveryActive) return;
    this.truthGuardRecoveryActive = true;
    (this as any).diagnostics?.fail?.("RESERVATION_FALSE_CONFIRMATION_BLOCKED", "BOOKED_EVIDENCE_MISSING", {
      reason,
    });
    (this as any).sendBestEffortCancel?.();
    setTimeout(() => {
      try {
        (this as any).createSpokenResponse(
          "Corrige inmediatamente cualquier impresión anterior: indica de forma breve y clara que la reserva NO está confirmada porque todavía no has recibido confirmación del sistema. No digas que está hecha, registrada o confirmada. Ofrece continuar intentándolo."
        );
        (this as any).diagnostics?.recovered?.("RESERVATION_TRUTH_CORRECTION_SPOKEN", "correct_false_confirmation_without_booked_evidence");
      } finally {
        setTimeout(() => { this.truthGuardRecoveryActive = false; }, 1500);
      }
    }, 100);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeTruthEvent | null = null;
    if (text) {
      try {
        event = JSON.parse(text) as RealtimeTruthEvent;
      } catch {
        event = null;
      }
    }

    if (event?.type === "response.created") {
      this.assistantTranscriptBuffer = "";
    }

    if (event?.type === "response.output_audio_transcript.delta" && typeof event.delta === "string") {
      this.assistantTranscriptBuffer += event.delta;
      if (!this.reservationBookedThisCall && soundsLikeReservationConfirmed(this.assistantTranscriptBuffer)) {
        this.triggerReservationTruthCorrection("assistant_audio_transcript_delta");
        return;
      }
    }

    if (event?.type === "response.done") {
      const recovered = this.recoverFunctionCallFromResponseDone(event);
      if (recovered?.call_id && recovered.arguments) {
        this.recoveredFunctionCallIds.add(recovered.call_id);
        (this as any).diagnostics?.recovered?.("FUNCTION_CALL_RECOVERED_FROM_RESPONSE_DONE", "function_call_arguments_done_event_missing", {
          tool: MANAGE_RESERVATION,
        });
        const synthetic = JSON.stringify({
          type: "response.function_call_arguments.done",
          name: MANAGE_RESERVATION,
          call_id: recovered.call_id,
          arguments: recovered.arguments,
        });
        await BasePrototype.handleRealtimeMessage.call(this, synthetic);
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (!event) return;

    if (event.type === "response.output_audio_transcript.done" && typeof event.transcript === "string") {
      this.assistantTranscriptBuffer = event.transcript;
      if (!this.reservationBookedThisCall && soundsLikeReservationConfirmed(event.transcript)) {
        this.triggerReservationTruthCorrection("assistant_audio_transcript_done");
      }
    }
  }
}
