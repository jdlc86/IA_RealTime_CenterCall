import { CallSession as CallSessionV9 } from "./call-session-v9";
import { cancellationFingerprint, chooseCancellationCandidate, emptyCancellationState, publicCancellationOptions, type CancellationState } from "./reservation-cancellation";
import { parseReservationTurn } from "./reservation-orchestrator";
import { parseSemanticDecision } from "./semantic-router";
import { SupabaseAdapter, type BookedReservationSummary } from "./supabase-adapter";

const CONVERSATION_INTENT = "conversation_intent";
const BaseConstructor = CallSessionV9 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV9.prototype as any;

type RealtimeEvent = { type?: string; name?: string; call_id?: string; arguments?: string; };

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function requireRuntimeString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function rawReservationOperation(argumentsJson: string | undefined): "CREATE" | "CANCEL" | null {
  if (!argumentsJson?.trim()) return null;
  try {
    const root = JSON.parse(argumentsJson) as Record<string, unknown>;
    const reservation = root.reservation;
    if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) return null;
    const operation = (reservation as Record<string, unknown>).operation;
    return operation === "CREATE" || operation === "CANCEL" ? operation : null;
  } catch {
    return null;
  }
}

export class CallSession extends BaseConstructor {
  private cancellationStateV10: CancellationState | null = null;

  private getCancellationAdapter(): SupabaseAdapter {
    return new SupabaseAdapter({
      SUPABASE_URL: requireRuntimeString((this as any).env?.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireRuntimeString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
  }

  private sendCancellationClassifierOutput(callId: string | undefined, stage: string): void {
    if (!callId) return;
    (this as any).send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ ok: true, action: "continue", data_requirement: "RESERVATION", reservation_operation: "CANCEL", stage }),
      },
    });
  }

  private resetCancellation(): void {
    this.cancellationStateV10 = null;
  }

  private async loadCandidates(): Promise<BookedReservationSummary[]> {
    const tenantId = requireRuntimeString((this as any).tenantId, "tenant_id");
    const callerPhone = requireRuntimeString((this as any).callerPhone, "caller_phone");
    return this.getCancellationAdapter().listBookedReservationsByPhone(tenantId, callerPhone);
  }

  private async handleCancellationTurn(argumentsJson: string | undefined, callId: string | undefined): Promise<void> {
    (this as any).state = "active";
    (this as any).ambiguousCount = 0;
    let turn;
    try {
      turn = parseReservationTurn(argumentsJson);
    } catch (error) {
      this.sendCancellationClassifierOutput(callId, "INVALID_CANCEL_REQUEST");
      (this as any).diagnostics?.fail?.("RESERVATION_CANCEL_TURN_INVALID", "RESERVATION_CANCEL_CLASSIFIER_PAYLOAD_INVALID", { error: error instanceof Error ? error.message : String(error) });
      (this as any).createSpokenResponse("No se ha cancelado ninguna reserva. Pide al usuario que indique de nuevo, brevemente, que desea cancelar una reserva existente.");
      return;
    }

    const tenantId = (this as any).tenantId as string | null | undefined;
    const callerPhone = (this as any).callerPhone as string | null | undefined;
    if (!tenantId || !callerPhone) {
      this.sendCancellationClassifierOutput(callId, "CALLER_ID_REQUIRED");
      this.resetCancellation();
      (this as any).diagnostics?.fail?.("RESERVATION_CANCEL_BLOCKED", "TRUSTED_CALLER_PHONE_UNAVAILABLE");
      (this as any).createSpokenResponse("No se ha cancelado ninguna reserva. Explica que no puedes verificar automáticamente las reservas asociadas a esta llamada y que debe usarse un canal alternativo del negocio. No pidas un número dictado como prueba de identidad.");
      return;
    }

    if (!this.cancellationStateV10) {
      const candidates = await this.loadCandidates();
      this.cancellationStateV10 = { ...emptyCancellationState(), candidates };
      (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCEL_LOOKUP_COMPLETED", { candidate_count: candidates.length, identity_source: "CALLER_ID" });
      if (candidates.length === 0) {
        this.sendCancellationClassifierOutput(callId, "NO_BOOKED_RESERVATIONS");
        this.resetCancellation();
        (this as any).createSpokenResponse("Indica que no has encontrado reservas futuras confirmadas asociadas al mismo número desde el que está llamando. No inventes reservas y no pidas el número para volver a verificar identidad.");
        return;
      }
    }

    const state = this.cancellationStateV10;
    if (!state.selectedId) {
      const selected = chooseCancellationCandidate(state.candidates, turn);
      if (!selected) {
        this.sendCancellationClassifierOutput(callId, "SELECT_RESERVATION");
        const options = publicCancellationOptions(state.candidates);
        (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCEL_SELECTION_REQUIRED", { candidate_count: options.length });
        (this as any).createSpokenResponse(`Hay varias reservas futuras verificadas asociadas a esta llamada. Presenta de forma breve y numerada únicamente estas opciones: ${JSON.stringify(options)}. No leas identificadores internos ni teléfonos. Pide que elija una opción; todavía no canceles nada.`);
        return;
      }
      state.selectedId = selected.id;
      state.confirmationFingerprint = cancellationFingerprint(selected);
      this.sendCancellationClassifierOutput(callId, "CONFIRM_CANCEL_RESERVATION");
      (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCEL_CONFIRMATION_ARMED", { reservation_id: selected.id });
      (this as any).createSpokenResponse(`Resume brevemente esta reserva verificada: ${JSON.stringify({ starts_at: selected.starts_at, party_size: selected.party_size, customer_name: selected.customer_name })}. Pregunta de forma inequívoca si desea cancelar ESTA reserva. No la canceles hasta recibir una confirmación explícita en un turno posterior.`);
      return;
    }

    const selected = state.candidates.find((candidate) => candidate.id === state.selectedId) ?? null;
    if (!selected || !state.confirmationFingerprint) {
      this.resetCancellation();
      this.sendCancellationClassifierOutput(callId, "CANCEL_STATE_INVALID");
      (this as any).createSpokenResponse("No se ha cancelado ninguna reserva. Indica que el proceso de cancelación debe iniciarse de nuevo.");
      return;
    }

    if (turn.confirm !== true) {
      this.sendCancellationClassifierOutput(callId, "CONFIRM_CANCEL_RESERVATION");
      (this as any).createSpokenResponse(`La cancelación sigue pendiente. Vuelve a preguntar de forma breve si confirma cancelar la reserva de ${JSON.stringify({ starts_at: selected.starts_at, party_size: selected.party_size })}. No canceles sin un sí inequívoco.`);
      return;
    }

    (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCEL_FINAL_RECHECK_STARTED", { reservation_id: selected.id });
    const latest = await this.loadCandidates();
    const current = latest.find((candidate) => candidate.id === selected.id) ?? null;
    if (!current || cancellationFingerprint(current) !== state.confirmationFingerprint) {
      this.resetCancellation();
      this.sendCancellationClassifierOutput(callId, "RESERVATION_CHANGED_BEFORE_CANCEL");
      (this as any).diagnostics?.fail?.("RESERVATION_CANCEL_RECHECK_FAILED", "RESERVATION_NO_LONGER_MATCHES_CONFIRMED_STATE", { reservation_id: selected.id });
      (this as any).createSpokenResponse("No se ha cancelado la reserva porque su estado cambió antes de completar la operación. Indica que es necesario iniciar de nuevo la consulta; no afirmes que está cancelada.");
      return;
    }

    const cancelled = await this.getCancellationAdapter().cancelBookedReservation(tenantId, selected.id, callerPhone);
    if (!cancelled) {
      this.resetCancellation();
      this.sendCancellationClassifierOutput(callId, "RESERVATION_NOT_CANCELLED");
      (this as any).diagnostics?.fail?.("RESERVATION_CANCEL_WRITE_FAILED", "BOOKED_ROW_NOT_FOUND_AT_WRITE", { reservation_id: selected.id });
      (this as any).createSpokenResponse("No se ha podido completar la cancelación porque la reserva ya no estaba disponible en el estado esperado. No digas que está cancelada.");
      return;
    }

    this.resetCancellation();
    (this as any).reservationDraft = {};
    this.sendCancellationClassifierOutput(callId, "CANCELLED");
    (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCELLED_EVIDENCE", { reservation_id: selected.id, identity_source: "CALLER_ID", previous_status: "BOOKED", new_status: "CANCELLED" });
    (this as any).createSpokenResponse(`La cancelación está confirmada por el backend. Comunícalo de forma breve usando estos datos: ${JSON.stringify({ starts_at: selected.starts_at, party_size: selected.party_size, status: "CANCELLED" })}. No preguntes por promociones como consecuencia de una cancelación.`);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === CONVERSATION_INTENT) {
      if ((this as any).state === "closing" || (this as any).hangupStarted === true) {
        await BasePrototype.handleRealtimeMessage.call(this, data);
        return;
      }

      const semantic = parseSemanticDecision(event.arguments);
      if (semantic.intent === "CONTINUE" && semantic.dataRequirement === "RESERVATION") {
        const explicitOperation = rawReservationOperation(event.arguments);
        if (explicitOperation === "CREATE" && this.cancellationStateV10) this.resetCancellation();
        const cancellationOwned = explicitOperation === "CANCEL" || (this.cancellationStateV10 !== null && explicitOperation !== "CREATE");
        if (cancellationOwned) {
          (this as any).diagnostics?.checkpoint?.("RESERVATION_OPERATION_ROUTED", { operation: "CANCEL", source: explicitOperation === "CANCEL" ? "classifier" : "active_workflow" });
          await this.handleCancellationTurn(event.arguments, event.call_id);
          return;
        }
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
