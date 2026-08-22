import { CallSession as CallSessionV38 } from "./call-session-v38";
import { humanHandoffPersistencePortFor } from "./human-handoff-persistence-port.js";
import { humanHandoffTransportPortFor } from "./human-handoff-transport-port.js";

const BaseConstructor = CallSessionV38 as unknown as new (...args: any[]) => any;

type HandoffTelnyxEvent = {
  handoff_id?: unknown;
  realtime_call_id?: unknown;
  tenant_id?: unknown;
  source_call_control_id?: unknown;
  event_type?: unknown;
  call_control_id?: unknown;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * v39 fixes transfer-success classification and keeps the handoff lifecycle
 * coherent once a real target-leg result has arrived.
 *
 * Telnyx transfer emits call.bridged while the destination can still be ringing.
 * The authoritative remote-answer signal is call.answered. Therefore:
 * - call.bridged is only an intermediate transport signal;
 * - only call.answered on the target leg marks TRANSFERRED and closes Lucía;
 * - target call.hangup before answer falls through to the inherited failure owner;
 * - when target call.hangup arrives, the transfer-result watchdog is cancelled
 *   immediately so it cannot later overwrite the precise failure result;
 * - v39 never reaches into historical CallSession state or methods directly;
 * - hangups after confirmed TRANSFERRED are terminal telephony bookkeeping only.
 */
export class CallSession extends BaseConstructor {
  private settleTargetFailureLifecycleV39(handoffId: string): void {
    humanHandoffTransportPortFor(this).cancelTransferWatchdog();
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TARGET_RESULT_SETTLED_V39", {
      handoff_id: handoffId,
      transfer_result_watchdog_cancelled: true,
      precise_failure_result_preserved: true,
      direct_version_state_mutation: false,
      transport_owner: "human_handoff_transport_port",
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/human-handoff/telnyx-event") {
      return super.fetch(request);
    }

    let event: HandoffTelnyxEvent;
    try { event = await request.clone().json() as HandoffTelnyxEvent; }
    catch { return super.fetch(request); }

    const handoffId = nonEmpty(event.handoff_id);
    const tenantId = nonEmpty(event.tenant_id);
    const sourceCallControlId = nonEmpty(event.source_call_control_id);
    const eventCallControlId = nonEmpty(event.call_control_id);
    const eventType = nonEmpty(event.event_type) ?? "unknown";
    const targetLeg = Boolean(eventCallControlId && sourceCallControlId && eventCallControlId !== sourceCallControlId);

    if (!handoffId || !tenantId || !sourceCallControlId) {
      return super.fetch(request);
    }

    if (eventType === "call.bridged") {
      const state = await humanHandoffPersistencePortFor(this).getState(handoffId, tenantId);
      if (state && state.status !== "TRANSFERRED") {
        (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_BRIDGE_OBSERVED_V39", {
          handoff_id: handoffId,
          target_leg: targetLeg,
          transfer_confirmed: false,
          waiting_for: "call.answered_or_call.hangup",
        });
        return Response.json({ ok: true, action: "bridge_observed_waiting_answer" });
      }
      if (state?.status === "TRANSFERRED") {
        return Response.json({ ok: true, ignored: true, reason: "already_transferred" });
      }
    }

    if (eventType === "call.answered" && targetLeg && eventCallControlId) {
      const state = await humanHandoffPersistencePortFor(this).getState(handoffId, tenantId);
      if (state?.status === "TRANSFERRED") {
        return Response.json({ ok: true, ignored: true, reason: "already_transferred" });
      }
      if (state && (state.status === "DIALING" || state.status === "ANSWERED")) {
        await humanHandoffTransportPortFor(this).markTransferred(eventCallControlId);
        (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TRANSFERRED_V39", {
          handoff_id: handoffId,
          human_answer_confirmed: true,
          confirmation_event: "call.answered",
          terminal_operation_owner: "human_handoff_transport_port",
          direct_runtime_closing_mutation: false,
          callback_required: false,
          lucia_conversation_resumes: false,
        });
        return Response.json({ ok: true, action: "transfer_confirmed_by_answer" });
      }
    }

    if (eventType === "call.hangup") {
      const state = await humanHandoffPersistencePortFor(this).getState(handoffId, tenantId);
      if (state?.status === "TRANSFERRED") {
        if (!targetLeg) {
          await humanHandoffPersistencePortFor(this).update(handoffId, tenantId, { call_terminated_at: new Date().toISOString() });
        }
        return Response.json({ ok: true, action: "post_transfer_hangup_recorded" });
      }

      if (targetLeg) {
        this.settleTargetFailureLifecycleV39(handoffId);
        return super.fetch(request);
      }
    }

    return super.fetch(request);
  }
}
