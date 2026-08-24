import type {
  AuthoritativeReservationDateDecision,
  AuthoritativeReservationDateRangeDecision,
} from "./authoritative-temporal-context-port.js";
import { authoritativeTemporalContextPortFor } from "./authoritative-temporal-context-runtime.js";
import { realtimeCommandPortFor } from "./realtime-provider-runtime.js";

type BlockedTemporalDateDecision = Extract<
  AuthoritativeReservationDateDecision,
  { action: "BLOCK_MISMATCH" | "BLOCK_AMBIGUOUS" }
>;

export type ReservationRelativeDateAuthorityRequest = Readonly<{
  callId?: string;
  toolName: string;
  requestedLocalDate: string;
  authorizeSemanticTool(): boolean;
}>;

export type ReservationRelativeDateAuthorityOutcome = Readonly<{
  handled: boolean;
  decision: AuthoritativeReservationDateDecision;
}>;

type BlockedTemporalDateRangeDecision = Extract<
  AuthoritativeReservationDateRangeDecision,
  { action: "BLOCK_RANGE_MISMATCH" | "BLOCK_RANGE_UNPROVEN" }
>;

export type ReservationRelativeDateRangeAuthorityRequest = Readonly<{
  callId?: string;
  toolName: string;
  requestedFromLocalDate: string;
  requestedToLocalDateExclusive: string;
  authorizeSemanticTool(): boolean;
}>;

export type ReservationRelativeDateRangeAuthorityOutcome = Readonly<{
  handled: boolean;
  decision: AuthoritativeReservationDateRangeDecision;
}>;

function rejectionOutput(decision: BlockedTemporalDateDecision): Record<string, unknown> {
  const mismatch = decision.action === "BLOCK_MISMATCH";
  return {
    ok: true,
    status: mismatch ? "RELATIVE_DATE_MISMATCH" : "RELATIVE_DATE_AMBIGUOUS",
    date_authoritative: false,
    requested_local_date: mismatch ? decision.requestedLocalDate : null,
    authoritative_local_date: mismatch ? decision.authoritativeLocalDate : null,
    authoritative_local_dates: mismatch ? null : decision.authoritativeLocalDates,
    requires_new_caller_turn: true,
    availability_checked: false,
    reservation_write_attempted: false,
    instruction: mismatch
      ? "La fecha relativa se materializó con un contexto temporal obsoleto. No consultes disponibilidad ni reserves todavía. Explica la fecha absoluta correcta indicada por authoritative_local_date y pide al cliente que confirme esa fecha concreta en un nuevo turno."
      : "La petición contiene más de una fecha relativa posible. No elijas una por tu cuenta. Pide al cliente una única fecha concreta y espera un nuevo turno hablado.",
  };
}

function previousLocalDate(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("Authoritative range end date is invalid");
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1))
    .toISOString()
    .slice(0, 10);
}

function rangeRejectionOutput(decision: BlockedTemporalDateRangeDecision): Record<string, unknown> {
  const mismatch = decision.action === "BLOCK_RANGE_MISMATCH";
  return {
    ok: true,
    status: mismatch ? "RELATIVE_DATE_RANGE_MISMATCH" : "RELATIVE_DATE_RANGE_UNPROVEN",
    date_range_authoritative: false,
    requested_from_local_date: mismatch ? decision.requestedFromLocalDate : null,
    requested_to_local_date_exclusive: mismatch ? decision.requestedToLocalDateExclusive : null,
    authoritative_from_local_date: mismatch ? decision.authoritativeFromLocalDate : null,
    authoritative_to_local_date_exclusive: mismatch ? decision.authoritativeToLocalDateExclusive : null,
    authoritative_last_included_local_date: mismatch ? previousLocalDate(decision.authoritativeToLocalDateExclusive) : null,
    referenced_local_dates: mismatch ? null : decision.referencedLocalDates,
    requires_new_caller_turn: true,
    availability_checked: false,
    reservation_write_attempted: false,
    instruction: mismatch
      ? "El rango relativo se materializó con un contexto temporal obsoleto. No busques todavía. Explica el intervalo incluido usando authoritative_from_local_date y authoritative_last_included_local_date; no verbalices el límite técnico exclusivo. Pide al cliente que confirme ese intervalo en un nuevo turno."
      : "Las fechas relativas no demuestran un intervalo continuo y una búsqueda from/to incluiría días no autorizados. No amplíes el rango. Pide al cliente un intervalo continuo concreto o una sola fecha y espera un nuevo turno hablado.",
  };
}

/**
 * Product-owned reservation-date effect boundary. It consumes a stale or
 * ambiguous relative-date tool exactly once and returns backend evidence through
 * the normal tool-result channel; it never mutates provider conversation input.
 */
export function enforceReservationRelativeDateAuthority(
  session: object,
  request: ReservationRelativeDateAuthorityRequest,
): ReservationRelativeDateAuthorityOutcome {
  const decision = authoritativeTemporalContextPortFor(session as any)
    .decideReservationDate(request.requestedLocalDate);
  if (decision.action !== "BLOCK_MISMATCH" && decision.action !== "BLOCK_AMBIGUOUS") {
    if (decision.action === "ALLOW") {
      (session as any).diagnostics?.checkpoint?.("RESERVATION_RELATIVE_DATE_AUTHORIZED_V50", {
        tool: request.toolName,
        caller_item_id: decision.itemId,
        authoritative_local_date: decision.authoritativeLocalDate,
        authority_owner: "authoritative_temporal_context_port",
      });
    }
    return Object.freeze({ handled: false, decision });
  }

  if (!request.authorizeSemanticTool()) return Object.freeze({ handled: true, decision });
  (session as any).diagnostics?.checkpoint?.("RESERVATION_RELATIVE_DATE_BLOCKED_V50", {
    tool: request.toolName,
    reason: decision.action,
    caller_item_id: decision.itemId,
    requested_local_date: decision.action === "BLOCK_MISMATCH" ? decision.requestedLocalDate : null,
    authoritative_local_date: decision.action === "BLOCK_MISMATCH" ? decision.authoritativeLocalDate : null,
    authoritative_local_dates: decision.action === "BLOCK_AMBIGUOUS" ? decision.authoritativeLocalDates : null,
    semantic_decision_consumed: true,
    availability_checked: false,
    reservation_write_attempted: false,
    authority_owner: "authoritative_temporal_context_port",
  });
  const realtime = realtimeCommandPortFor(session as any);
  realtime.submitToolResult({
    callId: request.callId,
    toolName: request.toolName,
    output: rejectionOutput(decision),
  });
  realtime.createDefaultResponse();
  return Object.freeze({ handled: true, decision });
}

export function enforceReservationRelativeDateRangeAuthority(
  session: object,
  request: ReservationRelativeDateRangeAuthorityRequest,
): ReservationRelativeDateRangeAuthorityOutcome {
  const decision = authoritativeTemporalContextPortFor(session as any).decideReservationDateRange(
    request.requestedFromLocalDate,
    request.requestedToLocalDateExclusive,
  );
  if (decision.action !== "BLOCK_RANGE_MISMATCH" && decision.action !== "BLOCK_RANGE_UNPROVEN") {
    if (decision.action === "ALLOW_RANGE") {
      (session as any).diagnostics?.checkpoint?.("RESERVATION_RELATIVE_DATE_RANGE_AUTHORIZED_V50", {
        tool: request.toolName,
        caller_item_id: decision.itemId,
        authoritative_from_local_date: decision.authoritativeFromLocalDate,
        authoritative_to_local_date_exclusive: decision.authoritativeToLocalDateExclusive,
        authority_owner: "authoritative_temporal_context_port",
      });
    }
    return Object.freeze({ handled: false, decision });
  }
  if (!request.authorizeSemanticTool()) return Object.freeze({ handled: true, decision });
  (session as any).diagnostics?.checkpoint?.("RESERVATION_RELATIVE_DATE_RANGE_BLOCKED_V50", {
    tool: request.toolName,
    reason: decision.action,
    caller_item_id: decision.itemId,
    availability_checked: false,
    reservation_write_attempted: false,
    semantic_decision_consumed: true,
    authority_owner: "authoritative_temporal_context_port",
  });
  const realtime = realtimeCommandPortFor(session as any);
  realtime.submitToolResult({
    callId: request.callId,
    toolName: request.toolName,
    output: rangeRejectionOutput(decision),
  });
  realtime.createDefaultResponse();
  return Object.freeze({ handled: true, decision });
}
