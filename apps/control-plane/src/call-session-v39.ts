import { CallSession as CallSessionV38 } from "./call-session-v38";
import { HumanHandoffStore } from "./human-handoff-store";

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
 * v39 fixes transfer-success classification and keeps the v37/v38 lifecycle
 * coherent once a real target-leg result has arrived.
 *
 * Telnyx transfer emits call.bridged while the destination can still be ringing.
 * The authoritative remote-answer signal is call.answered. Therefore:
 * - call.bridged is only an intermediate transport signal;
 * - only call.answered on the target leg marks TRANSFERRED and closes Lucía;
 * - target call.hangup before answer falls through to v38 NO_ANSWER/BUSY/FAILED;
 * - when target call.hangup arrives, the older v37 result watchdog is cancelled
 *   immediately so it cannot later overwrite the precise failure result;
 * - hangups after confirmed TRANSFERRED are terminal telephony bookkeeping only.
 */
export class CallSession extends BaseConstructor {
  private storeV39(): HumanHandoffStore {
    const env = (this as any).env ?? {};
    return new HumanHandoffStore({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY });
  }

  private settleTargetFailureLifecycleV39(handoffId: string): void {
    // v37 owns the transfer-result watchdog. v38 owns terminal TTS after a real
    // target-leg hangup. Once that hangup exists, waiting for a transfer-result
    // webhook is no longer meaningful and must not be allowed to fire later.
    (this as any).clearTransferWatchdogV37?.();
    const active = (this as any).activeHandoffV37 as { id?: string; phase?: string } | null | undefined;
    if (active?.id === handoffId && active.phase === "DIALING") {
      active.phase = "FAILURE_SPEAKING";
    }
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TARGET_RESULT_SETTLED_V39", {
      handoff_id: handoffId,
      transfer_result_watchdog_cancelled: true,
      precise_failure_result_preserved: true,
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
      const state = await this.storeV39().getState(handoffId, tenantId);
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
      const state = await this.storeV39().getState(handoffId, tenantId);
      if (state?.status === "TRANSFERRED") {
        return Response.json({ ok: true, ignored: true, reason: "already_transferred" });
      }
      if (state && (state.status === "DIALING" || state.status === "ANSWERED")) {
        const now = new Date().toISOString();
        (this as any).clearTransferWatchdogV37?.();
        await this.storeV39().update(handoffId, tenantId, {
          status: "TRANSFERRED",
          answered_at: now,
          transfer_ended_at: now,
          callback_required: false,
          callback_status: null,
          failure_reason: null,
          target_call_control_id: eventCallControlId,
        });
        (this as any).hangupStarted = true;
        (this as any).state = "closing";
        try { (this as any).socket?.close?.(1000, "human_handoff_answered_v39"); } catch { /* best effort */ }
        (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TRANSFERRED_V39", {
          handoff_id: handoffId,
          human_answer_confirmed: true,
          confirmation_event: "call.answered",
          ai_sideband_closed: true,
          callback_required: false,
          lucia_conversation_resumes: false,
        });
        return Response.json({ ok: true, action: "transfer_confirmed_by_answer" });
      }
    }

    if (eventType === "call.hangup") {
      const state = await this.storeV39().getState(handoffId, tenantId);
      if (state?.status === "TRANSFERRED") {
        if (!targetLeg) {
          await this.storeV39().update(handoffId, tenantId, { call_terminated_at: new Date().toISOString() });
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
