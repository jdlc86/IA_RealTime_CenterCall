import { CallSession as CallSessionV49 } from "./call-session-v49-provider-selection";
import { businessWindowsForDate, normalizeReservationLocalDateTime } from "./reservation-business-hours.js";
import {
  decideReservationDateScope,
  type ReservationDateScopePendingChange,
} from "./reservation-date-scope-policy.js";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import { authorizePublicRestaurantTool } from "./semantic-turn-coordinator.js";

const BaseConstructor = CallSessionV49 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV49.prototype as any;

const CREATE_RESERVATION = "restaurant_reservation_create";
const SEARCH_RESERVATION = "restaurant_reservation_search";
const RESTAURANT_TIMEZONE = "Europe/Madrid";

type GuardedReservationTool = typeof CREATE_RESERVATION | typeof SEARCH_RESERVATION;
type PendingDateChangeV50 = ReservationDateScopePendingChange;
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

export class CallSession extends BaseConstructor {
  private activeReservationLocalDateV50: string | null = null;
  private pendingReservationDateChangeV50: PendingDateChangeV50 | null = null;
  private callerTurnEpochV50 = 0;
  private lastCallerTranscriptItemIdV50: string | null = null;

  private observeCallerTurnV50(event: RealtimeProviderEvent): void {
    if (event.type !== "CALLER_TRANSCRIPT_COMPLETED" || !event.transcript.trim()) return;
    if (event.itemId) {
      if (event.itemId === this.lastCallerTranscriptItemIdV50) return;
      this.lastCallerTranscriptItemIdV50 = event.itemId;
    } else {
      this.lastCallerTranscriptItemIdV50 = null;
    }
    this.callerTurnEpochV50 += 1;
    (this as any).diagnostics?.checkpoint?.("RESERVATION_DATE_CALLER_TURN_V50", {
      caller_turn_epoch: this.callerTurnEpochV50,
      item_id: event.itemId ?? null,
      semantic_interpretation: false,
    });
  }

  private authorizeBlockedDateToolV50(event: SemanticToolEvent): boolean {
    const result = authorizePublicRestaurantTool(this, {
      name: event.name,
      call_id: event.callId,
      arguments: event.arguments,
    });
    if (!result.allowed) {
      (this as any).diagnostics?.fail?.(
        "RESERVATION_DATE_SCOPE_AUTHORITY_MISSING_V50",
        "SEMANTIC_TOOL_AUTHORITY_REJECTED",
        { tool: event.name, duplicate_of: result.duplicateOf },
      );
    }
    return result.allowed;
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

    const decision = decideReservationDateScope({
      activeLocalDate: this.activeReservationLocalDateV50,
      requestedLocalDate,
      pendingChange: this.pendingReservationDateChangeV50,
      currentCallerTurnEpoch: this.callerTurnEpochV50,
    });

    if (decision.action === "REQUIRE_CONFIRMATION") {
      if (!this.authorizeBlockedDateToolV50(toolEvent)) return;
      this.pendingReservationDateChangeV50 = {
        fromLocalDate: decision.fromLocalDate,
        toLocalDate: decision.toLocalDate,
        requestedAtCallerTurnEpoch: this.callerTurnEpochV50,
      };
      (this as any).diagnostics?.checkpoint?.("RESERVATION_DATE_CHANGE_BLOCKED_V50", {
        tool: toolEvent.name,
        from_local_date: decision.fromLocalDate,
        to_local_date: decision.toLocalDate,
        caller_turn_epoch: this.callerTurnEpochV50,
        semantic_decision_consumed: true,
        business_action_executed: false,
      });
      this.sendDateChangeRequiredV50(toolEvent, decision.fromLocalDate, decision.toLocalDate);
      return;
    }

    if (decision.action === "ALLOW_AND_SET" || decision.action === "ALLOW_CONFIRMED_CHANGE") {
      this.activeReservationLocalDateV50 = decision.localDate;
      this.pendingReservationDateChangeV50 = null;
      (this as any).diagnostics?.checkpoint?.(
        decision.action === "ALLOW_AND_SET" ? "RESERVATION_DATE_SCOPE_ESTABLISHED_V50" : "RESERVATION_DATE_CHANGE_CONFIRMED_V50",
        { tool: toolEvent.name, local_date: decision.localDate, caller_turn_epoch: this.callerTurnEpochV50 },
      );
    } else {
      this.pendingReservationDateChangeV50 = null;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
