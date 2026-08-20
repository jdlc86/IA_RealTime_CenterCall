import { CallSession as CallSessionV52 } from "./call-session-v52-trusted-reservation-contact";
import { decideReservationTimeAuthority } from "./reservation-time-authority.js";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";

const BaseConstructor = CallSessionV52 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV52.prototype as any;
const CREATE_RESERVATION = "restaurant_reservation_create";
const MODIFY_RESERVATION = "restaurant_reservation_modify";

type GuardedReservationTool = typeof CREATE_RESERVATION | typeof MODIFY_RESERVATION;
type SemanticToolEvent = Extract<RealtimeProviderEvent, { type: "SEMANTIC_TOOL_SELECTED" }>;

function guardedTool(name: string): name is GuardedReservationTool {
  return name === CREATE_RESERVATION || name === MODIFY_RESERVATION;
}

function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
  return parsed as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class CallSession extends BaseConstructor {
  private latestCallerTranscriptV53: string | null = null;
  private authorizedStartsAtV53: Partial<Record<GuardedReservationTool, string>> = {};
  private awaitingReservationTimeAnswerV53 = false;

  private observeCallerTurnV53(event: RealtimeProviderEvent): void {
    if (event.type !== "CALLER_TRANSCRIPT_COMPLETED" || !event.transcript.trim()) return;
    const consolidated = typeof (this as any).consolidatedCallerTurnV54 === "string"
      ? (this as any).consolidatedCallerTurnV54.trim()
      : "";
    this.latestCallerTranscriptV53 = consolidated || event.transcript.trim();
    (this as any).diagnostics?.checkpoint?.("RESERVATION_TIME_CALLER_EVIDENCE_OBSERVED_V53", {
      item_id: event.itemId ?? null,
      transcript_present: true,
      consolidated_turn_used: Boolean(consolidated),
      pending_slot: this.awaitingReservationTimeAnswerV53 ? "starts_at_time" : null,
      semantic_interpretation: false,
    });
  }

  private consumeBlockedToolAuthorityV53(event: SemanticToolEvent): boolean {
    const authorize = (this as any).authorizePublicRestaurantToolV29;
    if (typeof authorize !== "function") {
      (this as any).diagnostics?.fail?.(
        "RESERVATION_TIME_AUTHORITY_MISSING_V53",
        "V29_PUBLIC_TOOL_AUTHORITY_UNAVAILABLE",
        { tool: event.name, fail_closed: true },
      );
      return false;
    }
    return authorize.call(this, {
      type: "response.function_call_arguments.done",
      name: event.name,
      call_id: event.callId,
      arguments: event.arguments,
    });
  }

  private rejectUnprovenTimeV53(event: SemanticToolEvent, reason: string): void {
    const tool = event.name as GuardedReservationTool;
    this.awaitingReservationTimeAnswerV53 = true;
    const realtime = realtimeCommandPortFor(this as any);
    realtime.submitToolResult({
      callId: event.callId,
      toolName: tool,
      output: {
        ok: true,
        status: "MISSING_INFORMATION",
        missing: ["starts_at_time"],
        time_authoritative: false,
        reservation_created: false,
        instruction: "No asumas ninguna hora. Pregunta al cliente a qué hora quiere la reserva y espera un nuevo turno hablado antes de volver a intentar esta operación.",
      },
    });
    realtime.createDefaultResponse();
    (this as any).diagnostics?.checkpoint?.("RESERVATION_TIME_ASSUMPTION_BLOCKED_V53", {
      tool,
      reason,
      pending_slot: "starts_at_time",
      availability_checked: false,
      reservation_write_attempted: false,
      speech_owner: "direct_agent_runtime_v26",
      duplicate_speech_suppressed: true,
      post_tool_response_boundary_advanced: true,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptRealtimeProviderEvents(data);
    for (const event of providerEvents) this.observeCallerTurnV53(event);

    const toolEvent = providerEvents.find(
      (candidate): candidate is SemanticToolEvent =>
        candidate.type === "SEMANTIC_TOOL_SELECTED" && guardedTool(candidate.name),
    );

    if (!toolEvent || !guardedTool(toolEvent.name)) {
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    let args: Record<string, unknown>;
    try {
      args = parseObject(toolEvent.arguments);
    } catch {
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    const startsAt = text(args.starts_at);
    if (!startsAt) {
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    const decision = decideReservationTimeAuthority({
      requestedStartsAt: startsAt,
      latestCallerTranscript: this.latestCallerTranscriptV53,
      authorizedStartsAt: this.authorizedStartsAtV53[toolEvent.name] ?? null,
      pendingSlot: this.awaitingReservationTimeAnswerV53 ? "starts_at_time" : null,
    });

    if (decision.action === "BLOCK") {
      if (!this.consumeBlockedToolAuthorityV53(toolEvent)) return;
      this.rejectUnprovenTimeV53(toolEvent, decision.reason);
      return;
    }

    if (decision.action === "ALLOW_NEW") {
      this.authorizedStartsAtV53[toolEvent.name] = startsAt;
      const resolvedPendingSlot = this.awaitingReservationTimeAnswerV53;
      this.awaitingReservationTimeAnswerV53 = false;
      (this as any).diagnostics?.checkpoint?.("RESERVATION_TIME_AUTHORITY_ESTABLISHED_V53", {
        tool: toolEvent.name,
        starts_at: startsAt,
        source: resolvedPendingSlot ? "PENDING_TIME_SLOT_CALLER_ANSWER" : "LATEST_CALLER_TRANSCRIPT",
        pending_slot_resolved: resolvedPendingSlot,
      });
    } else {
      this.awaitingReservationTimeAnswerV53 = false;
      (this as any).diagnostics?.checkpoint?.("RESERVATION_TIME_AUTHORITY_REUSED_V53", {
        tool: toolEvent.name,
        starts_at: startsAt,
      });
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (args.confirm === true) {
      delete this.authorizedStartsAtV53[toolEvent.name];
      this.latestCallerTranscriptV53 = null;
      this.awaitingReservationTimeAnswerV53 = false;
      (this as any).diagnostics?.checkpoint?.("RESERVATION_TIME_AUTHORITY_CONSUMED_V53", {
        tool: toolEvent.name,
        confirmed_mutation_attempt: true,
      });
    }
  }
}
