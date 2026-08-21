import { CallSession as CallSessionV37 } from "./call-session-v37";
import { classifyHandoffFailure, encodeHumanHandoffClientState, parseHumanHandoffConfig } from "./human-handoff";
import { humanHandoffPersistencePortFor } from "./human-handoff-persistence-port.js";
import { humanHandoffSourceLegPortFor } from "./human-handoff-source-leg-port.js";
import { tenantConfigurationKey, tenantConfigurationKeyV2 } from "./tenant-kv";

const BaseConstructor = CallSessionV37 as unknown as new (...args: any[]) => any;
const FAILURE_STATUSES = new Set(["NO_ANSWER", "BUSY", "FAILED"]);
const TERMINAL_SPEECH_WATCHDOG_MS = 15_000;

type HandoffTelnyxEvent = {
  handoff_id?: unknown;
  realtime_call_id?: unknown;
  tenant_id?: unknown;
  source_call_control_id?: unknown;
  event_type?: unknown;
  call_control_id?: unknown;
  hangup_cause?: unknown;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * v38 owns the terminal NO_ANSWER/BUSY/FAILED presentation policy.
 *
 * A transfer may detach/close the OpenAI SIP sideband before the target leg later
 * reports timeout/busy. Realtime therefore cannot be relied on for the terminal
 * failure sentence. When the source leg is still alive, v38 plays that sentence
 * through the provider-neutral source-leg port and waits for call.speak.ended
 * before hanging up.
 *
 * ConversationTurnLifecycle owns AI-conversation terminality only. Its CLOSING
 * state is not evidence that the physical source leg has ended during handoff.
 * Source-leg terminality is established by transport evidence normalized by the
 * source-leg port. Lucía never resumes after point-of-no-return.
 */
export class CallSession extends BaseConstructor {
  private terminalSpeechTimersV38 = new Map<string, ReturnType<typeof setTimeout>>();

  private async failureMessageV38(tenantId: string): Promise<string | null> {
    const kv = (this as any).env?.TENANT_CONFIG;
    if (!kv || typeof kv.get !== "function") return null;
    const raw = await kv.get(tenantConfigurationKeyV2(tenantId), { cacheTtl: 30 })
      ?? await kv.get(tenantConfigurationKey(tenantId), { cacheTtl: 30 });
    if (!raw) return null;
    const config = parseHumanHandoffConfig((JSON.parse(raw) as Record<string, unknown>).humanHandoff);
    return config?.enabled ? config.failurePolicy.message : null;
  }

  private clearTerminalSpeechTimerV38(handoffId: string): void {
    const timer = this.terminalSpeechTimersV38.get(handoffId);
    if (timer) clearTimeout(timer);
    this.terminalSpeechTimersV38.delete(handoffId);
  }

  private async recordSourceAlreadyTerminalV38(handoffId: string, tenantId: string, evidence: string): Promise<void> {
    this.clearTerminalSpeechTimerV38(handoffId);
    await humanHandoffPersistencePortFor(this).update(handoffId, tenantId, { call_terminated_at: new Date().toISOString() });
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_FAILURE_SOURCE_ALREADY_TERMINAL_V38", {
      handoff_id: handoffId,
      evidence,
      terminal_speech_attempted: false,
      lucia_conversation_resumes: false,
    });
  }

  private async hangupSourceV38(event: HandoffTelnyxEvent, trigger: string): Promise<void> {
    const handoffId = nonEmpty(event.handoff_id);
    const tenantId = nonEmpty(event.tenant_id);
    const sourceCallControlId = nonEmpty(event.source_call_control_id);
    if (!handoffId || !tenantId || !sourceCallControlId) return;
    this.clearTerminalSpeechTimerV38(handoffId);

    const result = await humanHandoffSourceLegPortFor(this).hangup({
      sourceCallControlId,
      commandId: `${handoffId}-terminal-hangup-v38`,
    });
    if (!result.ok && !result.alreadyEnded) {
      (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_TERMINAL_HANGUP_FAILED_V38", "SOURCE_LEG_TERMINAL_HANGUP_FAILED", {
        handoff_id: handoffId,
        error: result.error ?? "source-leg hangup failed",
      });
    }

    await humanHandoffPersistencePortFor(this).update(handoffId, tenantId, { call_terminated_at: new Date().toISOString() });
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TERMINAL_CALL_ENDED_V38", {
      handoff_id: handoffId,
      trigger,
      telephony_terminated: result.ok,
      source_leg_already_ended: result.alreadyEnded,
      lucia_conversation_resumes: false,
      transport_owner: "human_handoff_source_leg_port",
    });
  }

  private async speakFailureOnSourceV38(event: HandoffTelnyxEvent): Promise<Response> {
    const handoffId = nonEmpty(event.handoff_id);
    const realtimeCallId = nonEmpty(event.realtime_call_id);
    const tenantId = nonEmpty(event.tenant_id);
    const sourceCallControlId = nonEmpty(event.source_call_control_id);
    const eventCallControlId = nonEmpty(event.call_control_id);
    if (!handoffId || !realtimeCallId || !tenantId || !sourceCallControlId || !eventCallControlId) {
      return Response.json({ ok: false, error: "missing_handoff_correlation" }, { status: 400 });
    }

    const state = await humanHandoffPersistencePortFor(this).getState(handoffId, tenantId);
    if (state?.status === "TRANSFERRED") {
      return super.fetch(new Request("https://call-session.internal/human-handoff/telnyx-event", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event),
      }));
    }

    const status = classifyHandoffFailure(event.hangup_cause);
    const failureReason = `TARGET_CALL_HANGUP:${nonEmpty(event.hangup_cause) ?? "unknown"}`;
    await humanHandoffPersistencePortFor(this).update(handoffId, tenantId, {
      status,
      transfer_ended_at: new Date().toISOString(),
      callback_required: true,
      callback_status: "PENDING",
      failure_reason: failureReason,
    });

    const message = await this.failureMessageV38(tenantId);
    if (!message) {
      await this.hangupSourceV38(event, "failure_message_configuration_unavailable");
      return Response.json({ ok: true, action: "failure_recorded_and_hung_up", status });
    }

    const clientState = encodeHumanHandoffClientState({
      kind: "human_handoff_v1",
      handoffId,
      realtimeCallId,
      tenantId,
      sourceCallControlId,
    });
    const result = await humanHandoffSourceLegPortFor(this).speakTerminal({
      sourceCallControlId,
      text: message,
      clientState,
      commandId: `${handoffId}-failure-terminal-speak-v38`,
    });

    if (result.alreadyEnded) {
      await this.recordSourceAlreadyTerminalV38(handoffId, tenantId, "source_leg_already_ended_during_terminal_speech");
      return Response.json({ ok: true, action: "failure_recorded_source_ended_during_speak", status });
    }

    if (!result.ok) {
      (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_FAILURE_SPEECH_FAILED_V38", "SOURCE_LEG_FAILURE_SPEECH_FAILED", {
        handoff_id: handoffId,
        error: result.error ?? "source-leg terminal speech failed",
      });
      await this.hangupSourceV38(event, "failure_message_source_leg_start_failed");
      return Response.json({ ok: true, action: "failure_speech_failed_and_hung_up", status });
    }

    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_FAILURE_SPEECH_STARTED_V38", {
      handoff_id: handoffId,
      status,
      transport: "SOURCE_LEG_TTS",
      transport_owner: "human_handoff_source_leg_port",
      lucia_conversation_resumes: false,
    });
    this.clearTerminalSpeechTimerV38(handoffId);
    this.terminalSpeechTimersV38.set(handoffId, setTimeout(() => {
      void this.hangupSourceV38(event, "failure_message_source_leg_watchdog");
    }, TERMINAL_SPEECH_WATCHDOG_MS));
    return Response.json({ ok: true, action: "failure_terminal_speech_started", status });
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

    if (eventType === "call.hangup" && targetLeg) {
      return this.speakFailureOnSourceV38(event);
    }

    if (eventType === "call.speak.ended" && !targetLeg && handoffId && tenantId) {
      const state = await humanHandoffPersistencePortFor(this).getState(handoffId, tenantId);
      if (state && state.callback_required && FAILURE_STATUSES.has(state.status)) {
        (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_FAILURE_SPEECH_COMPLETED_V38", {
          handoff_id: handoffId,
          status: state.status,
          transport: "SOURCE_LEG_TTS",
          transport_owner: "human_handoff_source_leg_port",
        });
        await this.hangupSourceV38(event, "failure_message_source_leg_speak_ended");
        return Response.json({ ok: true, action: "failure_terminal_speech_completed_and_hung_up" });
      }
    }

    if (eventType === "call.hangup" && !targetLeg && handoffId && tenantId) {
      const state = await humanHandoffPersistencePortFor(this).getState(handoffId, tenantId);
      if (state && state.callback_required && FAILURE_STATUSES.has(state.status)) {
        this.clearTerminalSpeechTimerV38(handoffId);
        await humanHandoffPersistencePortFor(this).update(handoffId, tenantId, { call_terminated_at: new Date().toISOString() });
        return Response.json({ ok: true, action: "source_hangup_preserved_failure_status" });
      }
    }

    return super.fetch(request);
  }
}
