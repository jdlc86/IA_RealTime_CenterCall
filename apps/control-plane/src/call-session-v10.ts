import { CallSession as CallSessionV9 } from "./call-session-v9";
import {
  restaurantReservationPortFor,
  type BookedReservationSummary,
} from "./restaurant-reservation-port.js";
import { cancellationFingerprint, chooseCancellationCandidates, publicCancellationOptions, publicSelectedReservations } from "./reservation-cancellation";
import { parseReservationTurn } from "./reservation-orchestrator";
import { parseSemanticDecision } from "./semantic-router";
import {
  executeLegacyIntent,
  LEGACY_INTENT_EXECUTOR,
  type LegacyIntentSelection,
} from "./legacy-intent-execution.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import { reservationRoutingRuntimeFor } from "./reservation-routing-runtime.js";

const CONVERSATION_INTENT = "conversation_intent";
const BaseConstructor = CallSessionV9 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV9.prototype as any;

function requireRuntimeString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function rawReservationOperation(argumentsJson: string | undefined): "CREATE" | "QUERY" | "CANCEL" | null {
  if (!argumentsJson?.trim()) return null;
  try {
    const root = JSON.parse(argumentsJson) as Record<string, unknown>;
    const reservation = root.reservation;
    if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) return null;
    const operation = (reservation as Record<string, unknown>).operation;
    return operation === "CREATE" || operation === "QUERY" || operation === "CANCEL" ? operation : null;
  } catch {
    return null;
  }
}

export class CallSession extends BaseConstructor {
  private sendCancellationClassifierOutput(callId: string | undefined, stage: string, details: Record<string, unknown> = {}): void {
    if (!callId) return;
    realtimeCommandPortFor(this as any).submitToolResult({
      callId,
      toolName: CONVERSATION_INTENT,
      output: {
        ok: true,
        action: "continue",
        data_requirement: "RESERVATION",
        reservation_operation: "CANCEL",
        stage,
        ...details,
      },
    });
  }

  private resetCancellation(): void {
    reservationRoutingRuntimeFor(this).clearCancellation();
  }

  private async loadCandidates(): Promise<BookedReservationSummary[]> {
    const tenantId = requireRuntimeString((this as any).tenantId, "tenant_id");
    const callerPhone = requireRuntimeString((this as any).callerPhone, "caller_phone");
    return restaurantReservationPortFor(this as any).listBookedReservationsByPhone(tenantId, callerPhone);
  }

  private async handleCancellationTurn(argumentsJson: string | undefined, callId: string | undefined): Promise<void> {
    const routing = reservationRoutingRuntimeFor(this);
    (this as any).state = "active";
    (this as any).ambiguousCount = 0;
    let turn;
    try {
      turn = parseReservationTurn(argumentsJson);
    } catch (error) {
      this.sendCancellationClassifierOutput(callId, "INVALID_CANCEL_REQUEST");
      (this as any).diagnostics?.fail?.("RESERVATION_CANCEL_TURN_INVALID", "RESERVATION_CANCEL_CLASSIFIER_PAYLOAD_INVALID", { error: error instanceof Error ? error.message : String(error) });
      (this as any).createSpokenResponse("No se ha cancelado ninguna reserva. Pide al usuario que indique de nuevo qué reserva o reservas desea cancelar.");
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

    if (!routing.snapshot().cancellationActive) {
      const candidates = await this.loadCandidates();
      routing.startCancellation(candidates);
      (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCEL_LOOKUP_COMPLETED", { candidate_count: candidates.length, identity_source: "CALLER_ID" });
      if (candidates.length === 0) {
        this.sendCancellationClassifierOutput(callId, "NO_BOOKED_RESERVATIONS");
        this.resetCancellation();
        (this as any).createSpokenResponse("Indica que no has encontrado reservas futuras confirmadas asociadas al mismo número desde el que está llamando. No inventes reservas y no pidas el número para volver a verificar identidad.");
        return;
      }
    }

    let state = routing.cancellation();
    if (!state) throw new Error("Cancellation routing state was not initialized");
    if (state.selectedIds.length === 0) {
      const selected = chooseCancellationCandidates(state.candidates, turn);
      if (selected.length === 0) {
        this.sendCancellationClassifierOutput(callId, "SELECT_RESERVATIONS");
        const options = publicCancellationOptions(state.candidates);
        (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCEL_SELECTION_REQUIRED", { candidate_count: options.length, multi_select_supported: true });
        (this as any).createSpokenResponse(`Hay reservas futuras verificadas asociadas a esta llamada. Presenta de forma breve y numerada únicamente estas opciones: ${JSON.stringify(options)}. No leas identificadores internos ni teléfonos. El usuario puede elegir una, varias opciones o todas. Todavía no canceles nada.`);
        return;
      }
      state = routing.selectCancellation(
        selected.map((reservation) => reservation.id),
        Object.fromEntries(selected.map((reservation) => [reservation.id, cancellationFingerprint(reservation)])),
      );
      this.sendCancellationClassifierOutput(callId, "CONFIRM_CANCEL_RESERVATIONS", { selected_count: selected.length });
      (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCEL_CONFIRMATION_ARMED", { selected_count: selected.length, reservation_ids: state.selectedIds });
      (this as any).createSpokenResponse(`Resume brevemente estas reservas verificadas que se van a cancelar: ${JSON.stringify(publicSelectedReservations(selected))}. Pregunta de forma inequívoca si confirma cancelar exactamente ${selected.length === 1 ? "esta reserva" : "estas reservas"}. No canceles nada hasta recibir una confirmación explícita en un turno posterior.`);
      return;
    }

    const selected = state.selectedIds.map((id) => state.candidates.find((candidate) => candidate.id === id)).filter((value): value is BookedReservationSummary => Boolean(value));
    if (selected.length !== state.selectedIds.length) {
      this.resetCancellation();
      this.sendCancellationClassifierOutput(callId, "CANCEL_STATE_INVALID");
      (this as any).createSpokenResponse("No se ha cancelado ninguna reserva. Indica que el proceso de cancelación debe iniciarse de nuevo.");
      return;
    }

    if (turn.confirm !== true) {
      this.sendCancellationClassifierOutput(callId, "CONFIRM_CANCEL_RESERVATIONS", { selected_count: selected.length });
      (this as any).createSpokenResponse(`La cancelación sigue pendiente. Pregunta de forma breve si confirma cancelar exactamente estas reservas: ${JSON.stringify(publicSelectedReservations(selected))}. No canceles sin un sí inequívoco.`);
      return;
    }

    (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCEL_FINAL_RECHECK_STARTED", { selected_count: selected.length, reservation_ids: state.selectedIds });
    const latest = await this.loadCandidates();
    const reservationPort = restaurantReservationPortFor(this as any);
    const results: Array<{ reservation_code: string; starts_at: string; party_size: number; status: "CANCELLED" | "NOT_CANCELLED"; reason?: string }> = [];

    for (const reservation of selected) {
      const current = latest.find((candidate) => candidate.id === reservation.id) ?? null;
      const expectedFingerprint = state.confirmationFingerprints[reservation.id];
      if (!current || !expectedFingerprint || cancellationFingerprint(current) !== expectedFingerprint) {
        results.push({ reservation_code: reservation.reservation_code, starts_at: reservation.starts_at, party_size: reservation.party_size, status: "NOT_CANCELLED", reason: "changed_before_cancel" });
        (this as any).diagnostics?.fail?.("RESERVATION_CANCEL_RECHECK_FAILED", "RESERVATION_NO_LONGER_MATCHES_CONFIRMED_STATE", { reservation_id: reservation.id });
        continue;
      }

      const cancelled = await reservationPort.cancelBookedReservation(tenantId, reservation.id, callerPhone);
      if (!cancelled) {
        results.push({ reservation_code: reservation.reservation_code, starts_at: reservation.starts_at, party_size: reservation.party_size, status: "NOT_CANCELLED", reason: "write_precondition_failed" });
        (this as any).diagnostics?.fail?.("RESERVATION_CANCEL_WRITE_FAILED", "BOOKED_ROW_NOT_FOUND_AT_WRITE", { reservation_id: reservation.id });
        continue;
      }

      results.push({ reservation_code: reservation.reservation_code, starts_at: reservation.starts_at, party_size: reservation.party_size, status: "CANCELLED" });
      (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCELLED_EVIDENCE", { reservation_id: reservation.id, reservation_code: reservation.reservation_code, identity_source: "CALLER_ID", previous_status: "BOOKED", new_status: "CANCELLED", batch_size: selected.length });
    }

    this.resetCancellation();
    (this as any).reservationDraft = {};
    const cancelledCount = results.filter((result) => result.status === "CANCELLED").length;
    const failedCount = results.length - cancelledCount;
    this.sendCancellationClassifierOutput(callId, failedCount === 0 ? "CANCELLED" : cancelledCount > 0 ? "PARTIALLY_CANCELLED" : "NOT_CANCELLED", { cancelled_count: cancelledCount, failed_count: failedCount });
    (this as any).diagnostics?.checkpoint?.("RESERVATION_CANCEL_BATCH_COMPLETED", { selected_count: selected.length, cancelled_count: cancelledCount, failed_count: failedCount });
    (this as any).createSpokenResponse(`Usa únicamente este resultado autorizado de cancelación: ${JSON.stringify(results)}. Informa claramente cuáles quedaron canceladas y, si alguna no pudo cancelarse, cuál no cambió. Usa solo reservation_code como referencia pública; nunca pronuncies ni muestres identificadores internos. No afirmes atomicidad ni rollback. No preguntes por promociones como consecuencia de una cancelación.`);
  }

  async [LEGACY_INTENT_EXECUTOR](selection: LegacyIntentSelection): Promise<void> {
    if (conversationLifecyclePortFor(this).isTerminal()) {
      await executeLegacyIntent(BasePrototype, this, selection);
      return;
    }

    const semantic = parseSemanticDecision(selection.argumentsJson);
    if (semantic.intent === "CONTINUE" && semantic.dataRequirement === "RESERVATION") {
      const explicitOperation = rawReservationOperation(selection.argumentsJson);
      const routing = reservationRoutingRuntimeFor(this).snapshot();
      if ((explicitOperation === "CREATE" || explicitOperation === "QUERY") && routing.cancellationActive) this.resetCancellation();
      const cancellationOwned = explicitOperation === "CANCEL" || (routing.cancellationActive && explicitOperation !== "CREATE" && explicitOperation !== "QUERY");
      if (cancellationOwned) {
        (this as any).diagnostics?.checkpoint?.("RESERVATION_OPERATION_ROUTED", { operation: "CANCEL", source: explicitOperation === "CANCEL" ? "classifier" : "active_workflow" });
        await this.handleCancellationTurn(selection.argumentsJson, selection.callId);
        return;
      }
    }

    await executeLegacyIntent(BasePrototype, this, selection);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = adaptRealtimeProviderEvents(data).find(
      (candidate) => candidate.type === "SEMANTIC_TOOL_SELECTED" && candidate.name === CONVERSATION_INTENT,
    );

    if (event?.type === "SEMANTIC_TOOL_SELECTED") {
      await this[LEGACY_INTENT_EXECUTOR]({ argumentsJson: event.arguments, callId: event.callId });
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
