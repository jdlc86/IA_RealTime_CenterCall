import { CallSession as CallSessionV51 } from "./call-session-v51-malformed-tool-authority";
import { decideReservationTimeAuthority } from "./reservation-time-authority.js";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import { reservationSessionRuntimeFor } from "./reservation-session-runtime.js";
import { reservationTimeSessionRuntimeFor, type ReservationTimeTool } from "./reservation-time-session-runtime.js";
import { callerTurnContextRuntimeFor } from "./caller-turn-context-runtime.js";
import { publicRestaurantToolAuthorizationPortFor } from "./semantic-tool-authorization-port.js";

const BaseConstructor = CallSessionV51 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV51.prototype as any;
const CREATE_RESERVATION: ReservationTimeTool = "restaurant_reservation_create";
const MODIFY_RESERVATION: ReservationTimeTool = "restaurant_reservation_modify";
type GuardedReservationTool = typeof CREATE_RESERVATION | typeof MODIFY_RESERVATION;
type SemanticToolEvent = Extract<RealtimeProviderEvent, { type: "SEMANTIC_TOOL_SELECTED" }>;

function guardedTool(name: string): name is GuardedReservationTool { return name === CREATE_RESERVATION || name === MODIFY_RESERVATION; }
function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
  return parsed as Record<string, unknown>;
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }

/** Compatibility adapter; all state lives in version-neutral session runtimes. */
export class CallSession extends BaseConstructor {
  private observeCallerTurnV53(event: RealtimeProviderEvent): void {
    if (event.type !== "CALLER_TRANSCRIPT_COMPLETED" || !event.transcript.trim()) return;
    const turnContext = callerTurnContextRuntimeFor(this);
    const effectiveTurn = turnContext.current() || event.transcript.trim();
    const timeRuntime = reservationTimeSessionRuntimeFor(this);
    timeRuntime.observeCallerTurn(effectiveTurn);
    (this as any).diagnostics?.checkpoint?.("RESERVATION_TIME_CALLER_EVIDENCE_OBSERVED_V53", {
      item_id: event.itemId ?? null,
      transcript_present: true,
      consolidated_turn_used: Boolean(turnContext.current()),
      pending_slot: timeRuntime.pendingSlot(),
      semantic_interpretation: false,
      authority_runtime: "reservation_time_session_runtime",
    });
  }

  private consumeBlockedToolAuthorityV53(event: SemanticToolEvent): boolean {
    const result = publicRestaurantToolAuthorizationPortFor(this).decide({
      name: event.name,
      call_id: event.callId,
      arguments: event.arguments,
    });
    const authorized = result.allowed && !result.ignored && !result.directedIgnoreRejected;
    if (!authorized) {
      (this as any).diagnostics?.fail?.("RESERVATION_TIME_AUTHORITY_MISSING_V53", "SEMANTIC_TOOL_AUTHORITY_REJECTED", {
        tool: event.name,
        duplicate_of: result.duplicateOf,
        ignored: result.ignored,
        directed_ignore_rejected: result.directedIgnoreRejected,
        fail_closed: true,
        semantic_authority_owner: "semantic_tool_authorization_port",
      });
    }
    return authorized;
  }

  private rejectUnprovenTimeV53(event: SemanticToolEvent, reason: string): void {
    const tool = event.name as GuardedReservationTool;
    reservationTimeSessionRuntimeFor(this).markAwaitingTimeAnswer();
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
      tool, reason, pending_slot: "starts_at_time", availability_checked: false,
      reservation_write_attempted: false, speech_owner: "direct_agent_runtime_v26",
      duplicate_speech_suppressed: true, post_tool_response_boundary_advanced: true,
    });
  }

  private consumeAuthorizedTimeV53(tool: GuardedReservationTool, reason: string): void {
    reservationTimeSessionRuntimeFor(this).consume(tool);
    (this as any).diagnostics?.checkpoint?.("RESERVATION_TIME_AUTHORITY_CONSUMED_V53", {
      tool, reason, backend_commit_required: tool === CREATE_RESERVATION, state_owner: "reservation_time_session_runtime",
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptRealtimeProviderEvents(data);
    for (const event of providerEvents) this.observeCallerTurnV53(event);
    const toolEvent = providerEvents.find((candidate): candidate is SemanticToolEvent => candidate.type === "SEMANTIC_TOOL_SELECTED" && guardedTool(candidate.name));
    if (!toolEvent || !guardedTool(toolEvent.name)) { await BasePrototype.handleRealtimeMessage.call(this, data); return; }

    let args: Record<string, unknown>;
    try { args = parseObject(toolEvent.arguments); } catch { await BasePrototype.handleRealtimeMessage.call(this, data); return; }
    const startsAt = text(args.starts_at);
    if (!startsAt) { await BasePrototype.handleRealtimeMessage.call(this, data); return; }

    const timeRuntime = reservationTimeSessionRuntimeFor(this);
    const decision = decideReservationTimeAuthority({
      requestedStartsAt: startsAt,
      latestCallerTranscript: timeRuntime.latestTurn(),
      authorizedStartsAt: timeRuntime.authorizedFor(toolEvent.name),
      pendingSlot: timeRuntime.pendingSlot(),
    });

    if (decision.action === "BLOCK") {
      if (!this.consumeBlockedToolAuthorityV53(toolEvent)) return;
      this.rejectUnprovenTimeV53(toolEvent, decision.reason);
      return;
    }

    if (decision.action === "ALLOW_NEW") {
      const { resolvedPendingSlot } = timeRuntime.establish(toolEvent.name, startsAt);
      (this as any).diagnostics?.checkpoint?.("RESERVATION_TIME_AUTHORITY_ESTABLISHED_V53", {
        tool: toolEvent.name, starts_at: startsAt,
        source: resolvedPendingSlot ? "PENDING_TIME_SLOT_CALLER_ANSWER" : "LATEST_CALLER_TRANSCRIPT",
        pending_slot_resolved: resolvedPendingSlot, state_owner: "reservation_time_session_runtime",
      });
    } else {
      timeRuntime.markReused();
      (this as any).diagnostics?.checkpoint?.("RESERVATION_TIME_AUTHORITY_REUSED_V53", {
        tool: toolEvent.name, starts_at: startsAt, state_owner: "reservation_time_session_runtime",
      });
    }

    const reservationRuntime = reservationSessionRuntimeFor(this);
    const commitEpochBefore = reservationRuntime.snapshot().commitEpoch;
    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (args.confirm === true) {
      if (toolEvent.name === CREATE_RESERVATION) {
        if (reservationRuntime.committedAfter(commitEpochBefore)) {
          this.consumeAuthorizedTimeV53(toolEvent.name, "backend_booked_commit");
        } else {
          (this as any).diagnostics?.checkpoint?.("RESERVATION_TIME_AUTHORITY_RETAINED_V53", {
            tool: toolEvent.name, starts_at: startsAt, reason: "create_not_committed",
            backend_commit_required: true, reservation_stage: reservationRuntime.snapshot().stage,
          });
        }
      } else {
        this.consumeAuthorizedTimeV53(toolEvent.name, "confirmed_modify_attempt_legacy");
      }
    }
  }
}
