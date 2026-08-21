import { CallSession as CallSessionV49 } from "./call-session-v49-provider-selection";
import { businessWindowsForDate, normalizeReservationLocalDateTime } from "./reservation-business-hours.js";
import { reservationDateScopeRuntimeFor } from "./reservation-date-scope-runtime.js";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import { publicRestaurantToolAuthorizationPortFor } from "./semantic-tool-authorization-port.js";

const BaseConstructor = CallSessionV49 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV49.prototype as any;

const CREATE_RESERVATION = "restaurant_reservation_create";
const SEARCH_RESERVATION = "restaurant_reservation_search";
const RESTAURANT_TIMEZONE = "Europe/Madrid";

type GuardedReservationTool = typeof CREATE_RESERVATION | typeof SEARCH_RESERVATION;
type SemanticToolEvent = Extract<RealtimeProviderEvent, { type: "SEMANTIC_TOOL_SELECTED" }>;

function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
  return parsed as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function guardedTool(name: string): name is GuardedReservationTool {
  return name === CREATE_RESERVATION || name === SEARCH_RESERVATION;
}

function requestedDateTime(tool: GuardedReservationTool, args: Record<string, unknown>): string | null {
  if (tool === CREATE_RESERVATION) return text(args.starts_at);
  return text(args.from) ?? text(args.preferred_starts_at);
}

function reservationLocalDate(raw: string): string {
  const normalized = normalizeReservationLocalDateTime(raw, RESTAURANT_TIMEZONE);
  return businessWindowsForDate(normalized, [], RESTAURANT_TIMEZONE).localDate;
}

/**
 * v50 enforces concrete reservation-date continuity but owns no cross-turn state.
 * Active date, pending change and caller-turn epoch live in the neutral
 * ReservationDateScopeRuntime; this layer adapts provider events and tool calls.
 */
export class CallSession extends BaseConstructor {
  private observeCallerTurnV50(event: RealtimeProviderEvent): void {
    if (event.type !== "CALLER_TRANSCRIPT_COMPLETED") return;
    const runtime = reservationDateScopeRuntimeFor(this);
    const observation = runtime.observeCallerTranscript(event.transcript, event.itemId);
    if (!observation.observed) return;
    (this as any).diagnostics?.checkpoint?.("RESERVATION_DATE_CALLER_TURN_V50", {
      caller_turn_epoch: observation.callerTurnEpoch,
      item_id: event.itemId ?? null,
      semantic_interpretation: false,
      state_owner: "reservation_date_scope_runtime",
    });
  }

  private authorizeBlockedDateToolV50(event: SemanticToolEvent): boolean {
    const result = publicRestaurantToolAuthorizationPortFor(this).decide({
      name: event.name,
      call_id: event.callId,
      arguments: event.arguments,
    });
    const allowed = result.allowed && !result.ignored && !result.directedIgnoreRejected;
    if (!allowed) {
      (this as any).diagnostics?.fail?.(
        "RESERVATION_DATE_SCOPE_AUTHORITY_MISSING_V50",
        "SEMANTIC_TOOL_AUTHORITY_REJECTED",
        { tool: event.name, duplicate_of: result.duplicateOf },
      );
    }
    return allowed;
  }

  private sendDateChangeRequiredV50(event: SemanticToolEvent, fromLocalDate: string, toLocalDate: string): void {
    const port = realtimeCommandPortFor(this as any);
    port.submitToolResult({
      callId: event.callId,
      toolName: event.name,
      output: {
        ok: true,
        status: "DATE_CHANGE_REQUIRES_CONFIRMATION",
        date_scope_authoritative: true,
        from_local_date: fromLocalDate,
        to_local_date: toLocalDate,
        requires_new_caller_turn: true,
        instruction: "La fecha activa de esta reserva es distinta. No busques ni reserves en la nueva fecha todavía. Explica el cambio concreto y pide confirmación al cliente. Solo después de un nuevo turno hablado del cliente puedes repetir la misma fecha solicitada.",
      },
    });
    port.createDefaultResponse();
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptRealtimeProviderEvents(data);
    for (const providerEvent of providerEvents) this.observeCallerTurnV50(providerEvent);
    const toolEvent = providerEvents.find(
      (candidate): candidate is SemanticToolEvent => candidate.type === "SEMANTIC_TOOL_SELECTED" && guardedTool(candidate.name),
    );
    if (!toolEvent || !guardedTool(toolEvent.name)) {
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    let args: Record<string, unknown>;
    try { args = parseObject(toolEvent.arguments); } catch {
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }
    const rawDateTime = requestedDateTime(toolEvent.name, args);
    if (!rawDateTime) {
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    let requestedLocalDate: string;
    try { requestedLocalDate = reservationLocalDate(rawDateTime); } catch {
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    const runtime = reservationDateScopeRuntimeFor(this);
    const decision = runtime.decide(requestedLocalDate);
    const snapshot = runtime.snapshot();

    if (decision.action === "REQUIRE_CONFIRMATION") {
      if (!this.authorizeBlockedDateToolV50(toolEvent)) return;
      runtime.stagePendingChange(decision.fromLocalDate, decision.toLocalDate);
      (this as any).diagnostics?.checkpoint?.("RESERVATION_DATE_CHANGE_BLOCKED_V50", {
        tool: toolEvent.name,
        from_local_date: decision.fromLocalDate,
        to_local_date: decision.toLocalDate,
        caller_turn_epoch: snapshot.callerTurnEpoch,
        semantic_decision_consumed: true,
        business_action_executed: false,
        state_owner: "reservation_date_scope_runtime",
      });
      this.sendDateChangeRequiredV50(toolEvent, decision.fromLocalDate, decision.toLocalDate);
      return;
    }

    runtime.accept(decision);
    const accepted = runtime.snapshot();
    if (decision.action === "ALLOW_AND_SET" || decision.action === "ALLOW_CONFIRMED_CHANGE") {
      (this as any).diagnostics?.checkpoint?.(
        decision.action === "ALLOW_AND_SET" ? "RESERVATION_DATE_SCOPE_ESTABLISHED_V50" : "RESERVATION_DATE_CHANGE_CONFIRMED_V50",
        {
          tool: toolEvent.name,
          local_date: decision.localDate,
          caller_turn_epoch: accepted.callerTurnEpoch,
          state_owner: "reservation_date_scope_runtime",
        },
      );
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
