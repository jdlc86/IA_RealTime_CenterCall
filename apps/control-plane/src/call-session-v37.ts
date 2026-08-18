import { CallSession as CallSessionV36 } from "./call-session-v36";
import { tenantConfigurationKey, tenantConfigurationKeyV2 } from "./tenant-kv";
import { suspendTurnDetectionEvent } from "./protected-turn-detection";
import {
  classifyHandoffFailure,
  encodeHumanHandoffClientState,
  parseHumanHandoffConfig,
  type HandoffFailureStatus,
  type HumanHandoffConfig,
} from "./human-handoff";
import { HumanHandoffStore } from "./human-handoff-store";

const BaseConstructor = CallSessionV36 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV36.prototype as any;
const HUMAN_ASSISTANCE = "restaurant_human_assistance";
const HANDOFF_METADATA_KEY = "human_handoff_v37";
const HANDOFF_SPEECH_WATCHDOG_MS = 15_000;
const HANDOFF_TRANSFER_WEBHOOK_GRACE_MS = 10_000;

type HandoffSpeechKind = "ANNOUNCEMENT" | "FAILURE_TERMINAL";
type HandoffPhase = "WAITING_VAD_OFF" | "ANNOUNCING" | "DIALING" | "FAILURE_SPEAKING" | "TRANSFERRED" | "TERMINATING";

type ActiveHandoff = {
  id: string;
  reason: string;
  summary?: string;
  phase: HandoffPhase;
  speechKind: HandoffSpeechKind | null;
  speechResponseId: string | null;
  targetCallControlId: string | null;
};

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  response_id?: string;
  response?: {
    id?: string;
    status?: string;
    metadata?: Record<string, unknown> | null;
  };
  session?: {
    audio?: {
      input?: {
        turn_detection?: unknown;
      };
    };
  };
};

type HandoffTelnyxEvent = {
  handoff_id?: unknown;
  realtime_call_id?: unknown;
  tenant_id?: unknown;
  source_call_control_id?: unknown;
  event_id?: unknown;
  event_type?: unknown;
  call_control_id?: unknown;
  call_leg_id?: unknown;
  call_session_id?: unknown;
  direction?: unknown;
  state?: unknown;
  hangup_cause?: unknown;
  hangup_source?: unknown;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function parseRealtimeEvent(data: unknown): RealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEvent; } catch { return null; }
}

function responseId(event: RealtimeEvent): string | null {
  return event.response_id ?? event.response?.id ?? null;
}

function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
  return parsed as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * v37 turns the existing semantic human-assistance decision into a transversal
 * deterministic transport. Lucia still decides *when* a human is needed; this
 * layer owns only configuration, traceability, telephony and terminal lifecycle.
 *
 * Point-of-no-return invariant:
 *   restaurant_human_assistance
 *   -> durable trace row exists
 *   -> VAD remains disabled
 *   -> exact protected announcement
 *   -> Telnyx blind transfer
 *   -> bridged: AI sideband is closed and human owns the call
 *   -> no-answer/busy/failure: exact protected terminal message -> hangup
 *
 * The caller never returns to Lucia after a configured handoff is accepted.
 */
export class CallSession extends BaseConstructor {
  private humanHandoffConfigV37: HumanHandoffConfig | undefined;
  private telnyxCallControlIdV37: string | null = null;
  private calledNumberV37: string | null = null;
  private activeHandoffV37: ActiveHandoff | null = null;
  private handoffSpeechWatchdogV37: ReturnType<typeof setTimeout> | null = null;
  private handoffTransferWatchdogV37: ReturnType<typeof setTimeout> | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/human-handoff/context") {
      return this.attachHandoffTransportContextV37(request);
    }
    if (request.method === "POST" && url.pathname === "/human-handoff/telnyx-event") {
      return this.handleTelnyxHandoffEventV37(request);
    }

    const isStart = request.method === "POST" && url.pathname === "/start";
    let tenantIdFromStart: string | null = null;
    if (isStart) {
      try {
        const body = await request.clone().json() as { tenant_id?: unknown };
        tenantIdFromStart = nonEmpty(body.tenant_id);
      } catch { /* base fetch owns request validation */ }
    }

    const response = await super.fetch(request);
    if (isStart && response.ok && tenantIdFromStart) {
      await this.loadHumanHandoffConfigV37(tenantIdFromStart);
    }
    return response;
  }

  private storeV37(): HumanHandoffStore {
    const env = (this as any).env ?? {};
    return new HumanHandoffStore({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY });
  }

  private async loadHumanHandoffConfigV37(tenantId: string): Promise<void> {
    const session = this as any;
    const kv = session.env?.TENANT_CONFIG;
    if (!kv || typeof kv.get !== "function") return;
    try {
      const raw = await kv.get(tenantConfigurationKeyV2(tenantId), { cacheTtl: 30 })
        ?? await kv.get(tenantConfigurationKey(tenantId), { cacheTtl: 30 });
      if (!raw) return;
      const record = JSON.parse(raw) as Record<string, unknown>;
      this.humanHandoffConfigV37 = parseHumanHandoffConfig(record.humanHandoff);
      session.diagnostics?.checkpoint?.("HUMAN_HANDOFF_CONFIG_LOADED_V37", {
        configured: this.humanHandoffConfigV37 !== undefined,
        enabled: this.humanHandoffConfigV37?.enabled === true,
        destination_type: this.humanHandoffConfigV37?.destination.type ?? null,
        destination_label: this.humanHandoffConfigV37?.destination.label ?? null,
        destination_phone_exposed_to_model: false,
      });
    } catch (error) {
      this.humanHandoffConfigV37 = undefined;
      session.diagnostics?.fail?.("HUMAN_HANDOFF_CONFIG_INVALID_V37", "HUMAN_HANDOFF_CONFIGURATION_INVALID", {
        error: error instanceof Error ? error.message : String(error),
        transfer_disabled_fail_closed: true,
      });
    }
  }

  private async attachHandoffTransportContextV37(request: Request): Promise<Response> {
    let body: { telnyx_call_control_id?: unknown; called_number?: unknown; realtime_call_id?: unknown };
    try { body = await request.json() as typeof body; }
    catch { return Response.json({ ok: false, error: "invalid_json" }, { status: 400 }); }

    const realtimeCallId = nonEmpty(body.realtime_call_id);
    const sessionCallId = nonEmpty((this as any).callId);
    if (realtimeCallId && sessionCallId && realtimeCallId !== sessionCallId) {
      return Response.json({ ok: false, error: "call_id_mismatch" }, { status: 409 });
    }
    const callControlId = nonEmpty(body.telnyx_call_control_id);
    const calledNumber = nonEmpty(body.called_number);
    if (!callControlId || !calledNumber) return Response.json({ ok: false, error: "missing_transport_context" }, { status: 400 });

    this.telnyxCallControlIdV37 = callControlId;
    this.calledNumberV37 = calledNumber;
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TRANSPORT_CONTEXT_ATTACHED_V37", {
      telnyx_call_control_id_present: true,
      called_number_present: true,
    });
    return Response.json({ ok: true });
  }

  private handoffPrerequisitesV37(): { tenantId: string; callId: string; callerPhone: string; sourceCallControlId: string; calledNumber: string; config: HumanHandoffConfig } | null {
    const session = this as any;
    const config = this.humanHandoffConfigV37;
    if (!config?.enabled) return null;
    const tenantId = nonEmpty(session.tenantId);
    const callId = nonEmpty(session.callId);
    const callerPhone = nonEmpty(session.callerPhone);
    const sourceCallControlId = nonEmpty(this.telnyxCallControlIdV37);
    const calledNumber = nonEmpty(this.calledNumberV37);
    if (!tenantId || !callId || !callerPhone || !sourceCallControlId || !calledNumber || !session.socket) return null;
    return { tenantId, callId, callerPhone, sourceCallControlId, calledNumber, config };
  }

  private async beginHumanHandoffV37(event: RealtimeEvent): Promise<boolean> {
    const prerequisites = this.handoffPrerequisitesV37();
    if (!prerequisites || this.activeHandoffV37) return false;

    let args: Record<string, unknown>;
    try { args = parseToolArgs(event.arguments); }
    catch { return false; }
    const reason = nonEmpty(args.reason) ?? "HUMAN_ASSISTANCE_REQUIRED";
    const summary = nonEmpty(args.context_summary)?.slice(0, 500);
    const handoffId = crypto.randomUUID();

    // Traceability is a precondition. If it cannot be persisted, leave the
    // historical v28 no-transfer behavior in control instead of making promises.
    try {
      await this.storeV37().create({
        id: handoffId,
        tenantId: prerequisites.tenantId,
        callId: prerequisites.callId,
        callerPhone: prerequisites.callerPhone,
        reasonCode: reason,
        reasonSummary: summary,
        destinationType: "PHONE",
        destinationLabel: prerequisites.config.destination.label,
        destinationPhone: prerequisites.config.destination.phone,
      });
    } catch (error) {
      (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_TRACE_CREATE_FAILED_V37", "HANDOFF_TRACEABILITY_UNAVAILABLE", {
        reason,
        error: error instanceof Error ? error.message : String(error),
        transfer_started: false,
      });
      return false;
    }

    this.activeHandoffV37 = {
      id: handoffId,
      reason,
      summary,
      phase: "WAITING_VAD_OFF",
      speechKind: null,
      speechResponseId: null,
      targetCallControlId: null,
    };

    // The semantic decision is complete. From here onward the deterministic
    // handoff controller owns the call and Lucía never resumes conversation.
    (this as any).releaseSemanticGateV29?.(HUMAN_ASSISTANCE);
    (this as any).observeHumanHandoffStartedV18?.();
    (this as any).detachTurnConcurrencyForTerminalV36?.("human_handoff_v37");

    (this as any).send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({
          ok: true,
          status: "HUMAN_HANDOFF_ACCEPTED",
          handoff_id: handoffId,
          transfer_available: true,
          callback_on_failure: true,
          terminal_lifecycle: true,
        }),
      },
    });

    await this.patchHandoffBestEffortV37({ status: "ANNOUNCING" });
    try {
      (this as any).send?.({ type: "input_audio_buffer.clear" });
      (this as any).send?.(suspendTurnDetectionEvent());
    } catch (error) {
      await this.failHandoffV37("FAILED", `VAD_SUSPEND_FAILED:${error instanceof Error ? error.message : String(error)}`);
      return true;
    }

    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_ACCEPTED_V37", {
      handoff_id: handoffId,
      reason,
      destination_label: prerequisites.config.destination.label,
      destination_phone_exposed_to_model: false,
      point_of_no_return: true,
      traceability_created: true,
    });
    return true;
  }
  private emitHandoffSpeechV37(kind: HandoffSpeechKind, text: string): void {
    const handoff = this.activeHandoffV37;
    if (!handoff) return;
    handoff.speechKind = kind;
    handoff.speechResponseId = null;
    handoff.phase = kind === "ANNOUNCEMENT" ? "ANNOUNCING" : "FAILURE_SPEAKING";
    (this as any).send?.({
      type: "response.create",
      response: {
        conversation: "none",
        tool_choice: "none",
        instructions: `Pronuncia exactamente esta frase y nada más: ${JSON.stringify(text)}`,
        metadata: { [HANDOFF_METADATA_KEY]: kind, handoff_id: handoff.id },
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Pronuncia exactamente: ${text}` }] }],
      },
    });
    this.armHandoffSpeechWatchdogV37(kind);
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_PROTECTED_SPEECH_REQUESTED_V37", {
      handoff_id: handoff.id,
      kind,
      vad_disabled: true,
      exact_speech: true,
    });
  }

  private armHandoffSpeechWatchdogV37(kind: HandoffSpeechKind): void {
    this.clearHandoffSpeechWatchdogV37();
    this.handoffSpeechWatchdogV37 = setTimeout(() => {
      if (!this.activeHandoffV37 || this.activeHandoffV37.speechKind !== kind) return;
      if (kind === "ANNOUNCEMENT") void this.failHandoffV37("FAILED", "ANNOUNCEMENT_PLAYBACK_TIMEOUT");
      else void this.terminateAfterHandoffFailureV37("failure_message_playback_timeout");
    }, HANDOFF_SPEECH_WATCHDOG_MS);
  }

  private clearHandoffSpeechWatchdogV37(): void {
    if (!this.handoffSpeechWatchdogV37) return;
    clearTimeout(this.handoffSpeechWatchdogV37);
    this.handoffSpeechWatchdogV37 = null;
  }

  private armTransferWatchdogV37(): void {
    this.clearTransferWatchdogV37();
    const timeoutMs = ((this.humanHandoffConfigV37?.transfer.answerTimeoutSeconds ?? 25) * 1000) + HANDOFF_TRANSFER_WEBHOOK_GRACE_MS;
    this.handoffTransferWatchdogV37 = setTimeout(() => {
      if (this.activeHandoffV37?.phase === "DIALING") void this.failHandoffV37("FAILED", "TRANSFER_RESULT_WEBHOOK_TIMEOUT");
    }, timeoutMs);
  }

  private clearTransferWatchdogV37(): void {
    if (!this.handoffTransferWatchdogV37) return;
    clearTimeout(this.handoffTransferWatchdogV37);
    this.handoffTransferWatchdogV37 = null;
  }

  private async startTelnyxTransferV37(): Promise<void> {
    const handoff = this.activeHandoffV37;
    const prerequisites = this.handoffPrerequisitesV37();
    if (!handoff || !prerequisites || handoff.phase !== "ANNOUNCING") return;
    this.clearHandoffSpeechWatchdogV37();
    handoff.phase = "DIALING";
    handoff.speechKind = null;
    handoff.speechResponseId = null;

    const now = new Date().toISOString();
    try {
      await this.storeV37().update(handoff.id, prerequisites.tenantId, { status: "DIALING", transfer_started_at: now });
    } catch (error) {
      await this.failHandoffV37("FAILED", `TRACE_UPDATE_BEFORE_TRANSFER_FAILED:${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const state = encodeHumanHandoffClientState({
      kind: "human_handoff_v1",
      handoffId: handoff.id,
      realtimeCallId: prerequisites.callId,
      tenantId: prerequisites.tenantId,
      sourceCallControlId: prerequisites.sourceCallControlId,
    });

    try {
      const apiKey = nonEmpty((this as any).env?.TELNYX_API_KEY);
      if (!apiKey) throw new Error("TELNYX_API_KEY unavailable");
      const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(prerequisites.sourceCallControlId)}/actions/transfer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          to: prerequisites.config.destination.phone,
          from: prerequisites.calledNumber,
          timeout_secs: prerequisites.config.transfer.answerTimeoutSeconds,
          command_id: `${handoff.id}-human-transfer`,
          client_state: state,
          target_leg_client_state: state,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Telnyx transfer HTTP ${response.status}: ${body.slice(0, 250)}`);
      }
      this.armTransferWatchdogV37();
      (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TRANSFER_STARTED_V37", {
        handoff_id: handoff.id,
        destination_label: prerequisites.config.destination.label,
        answer_timeout_seconds: prerequisites.config.transfer.answerTimeoutSeconds,
        destination_phone_exposed_to_model: false,
      });
    } catch (error) {
      await this.failHandoffV37("FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async patchHandoffBestEffortV37(patch: Parameters<HumanHandoffStore["update"]>[2]): Promise<void> {
    const handoff = this.activeHandoffV37;
    const tenantId = nonEmpty((this as any).tenantId);
    if (!handoff || !tenantId) return;
    try { await this.storeV37().update(handoff.id, tenantId, patch); }
    catch (error) {
      (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_TRACE_UPDATE_FAILED_V37", "HANDOFF_TRACE_UPDATE_FAILED", {
        handoff_id: handoff.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async failHandoffV37(status: HandoffFailureStatus, failureReason: string): Promise<void> {
    const handoff = this.activeHandoffV37;
    const config = this.humanHandoffConfigV37;
    if (!handoff || !config || handoff.phase === "TRANSFERRED" || handoff.phase === "TERMINATING") return;
    this.clearTransferWatchdogV37();
    this.clearHandoffSpeechWatchdogV37();
    await this.patchHandoffBestEffortV37({
      status,
      transfer_ended_at: new Date().toISOString(),
      callback_required: true,
      callback_status: "PENDING",
      failure_reason: failureReason.slice(0, 1000),
    });
    (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_TRANSFER_FAILED_V37", "HUMAN_TRANSFER_NOT_COMPLETED", {
      handoff_id: handoff.id,
      status,
      failure_reason: failureReason.slice(0, 300),
      callback_required: true,
      lucia_conversation_resumes: false,
    });
    this.emitHandoffSpeechV37("FAILURE_TERMINAL", config.failurePolicy.message);
  }

  private async terminateAfterHandoffFailureV37(trigger: string): Promise<void> {
    const handoff = this.activeHandoffV37;
    const sourceCallControlId = this.telnyxCallControlIdV37;
    const callId = nonEmpty((this as any).callId);
    if (!handoff || handoff.phase === "TRANSFERRED" || handoff.phase === "TERMINATING") return;
    handoff.phase = "TERMINATING";
    this.clearHandoffSpeechWatchdogV37();
    this.clearTransferWatchdogV37();
    (this as any).hangupStarted = true;
    (this as any).state = "closing";

    let terminated = false;
    if (sourceCallControlId) {
      try {
        const apiKey = nonEmpty((this as any).env?.TELNYX_API_KEY);
        if (!apiKey) throw new Error("TELNYX_API_KEY unavailable");
        const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(sourceCallControlId)}/actions/hangup`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ command_id: `${handoff.id}-terminal-hangup` }),
        });
        terminated = response.ok;
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Telnyx hangup HTTP ${response.status}: ${body.slice(0, 250)}`);
        }
      } catch (error) {
        (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_TELNYX_HANGUP_FAILED_V37", "TELNYX_TERMINAL_HANGUP_FAILED", {
          handoff_id: handoff.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!terminated && callId) {
      try {
        const openAiKey = nonEmpty((this as any).env?.OPENAI_API_KEY);
        if (!openAiKey) throw new Error("OPENAI_API_KEY unavailable");
        const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
          method: "POST",
          headers: { Authorization: `Bearer ${openAiKey}` },
        });
        terminated = response.ok;
        if (!response.ok) throw new Error(`OpenAI hangup HTTP ${response.status}`);
      } catch (error) {
        (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_OPENAI_HANGUP_FAILED_V37", "OPENAI_TERMINAL_HANGUP_FAILED", {
          handoff_id: handoff.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.patchHandoffBestEffortV37({ call_terminated_at: new Date().toISOString() });
    try { (this as any).socket?.close?.(1000, "human_handoff_terminal"); } catch { /* best effort */ }
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TERMINAL_CALL_ENDED_V37", {
      handoff_id: handoff.id,
      trigger,
      telephony_terminated: terminated,
      lucia_conversation_resumes: false,
    });
  }

  private async markHandoffTransferredV37(eventCallControlId: string | null): Promise<void> {
    const handoff = this.activeHandoffV37;
    if (!handoff || handoff.phase === "TRANSFERRED" || handoff.phase === "TERMINATING") return;
    this.clearTransferWatchdogV37();
    this.clearHandoffSpeechWatchdogV37();
    handoff.phase = "TRANSFERRED";
    if (eventCallControlId && eventCallControlId !== this.telnyxCallControlIdV37) handoff.targetCallControlId = eventCallControlId;
    await this.patchHandoffBestEffortV37({
      status: "TRANSFERRED",
      answered_at: new Date().toISOString(),
      transfer_ended_at: new Date().toISOString(),
      callback_required: false,
      callback_status: null,
      target_call_control_id: handoff.targetCallControlId,
    });
    (this as any).hangupStarted = true;
    (this as any).state = "closing";
    try { (this as any).socket?.close?.(1000, "human_handoff_transferred"); } catch { /* transfer itself terminates AI SIP leg */ }
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TRANSFERRED_V37", {
      handoff_id: handoff.id,
      human_connected: true,
      ai_sideband_closed: true,
      callback_required: false,
      lucia_conversation_resumes: false,
    });
  }

  private async handleTelnyxHandoffEventV37(request: Request): Promise<Response> {
    let event: HandoffTelnyxEvent;
    try { event = await request.json() as HandoffTelnyxEvent; }
    catch { return Response.json({ ok: false, error: "invalid_json" }, { status: 400 }); }
    const handoff = this.activeHandoffV37;
    if (!handoff) return Response.json({ ok: true, ignored: true, reason: "no_active_handoff" });

    const handoffId = nonEmpty(event.handoff_id);
    const realtimeCallId = nonEmpty(event.realtime_call_id);
    const tenantId = nonEmpty(event.tenant_id);
    const sourceCallControlId = nonEmpty(event.source_call_control_id);
    if (handoffId !== handoff.id || realtimeCallId !== nonEmpty((this as any).callId) || tenantId !== nonEmpty((this as any).tenantId) || sourceCallControlId !== this.telnyxCallControlIdV37) {
      return Response.json({ ok: true, ignored: true, reason: "handoff_correlation_mismatch" });
    }

    const eventType = nonEmpty(event.event_type) ?? "unknown";
    const eventCallControlId = nonEmpty(event.call_control_id);
    const targetLeg = Boolean(eventCallControlId && eventCallControlId !== sourceCallControlId);

    if (targetLeg && eventCallControlId && !handoff.targetCallControlId) {
      handoff.targetCallControlId = eventCallControlId;
      await this.patchHandoffBestEffortV37({ target_call_control_id: eventCallControlId });
    }

    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TELNYX_EVENT_V37", {
      handoff_id: handoff.id,
      event_type: eventType,
      target_leg: targetLeg,
      phase: handoff.phase,
    });

    if (eventType === "call.answered" && targetLeg && handoff.phase === "DIALING") {
      await this.patchHandoffBestEffortV37({ status: "ANSWERED", answered_at: new Date().toISOString(), target_call_control_id: eventCallControlId });
      return Response.json({ ok: true, action: "answered_recorded" });
    }

    if (eventType === "call.bridged" && handoff.phase === "DIALING") {
      await this.markHandoffTransferredV37(eventCallControlId);
      return Response.json({ ok: true, action: "transfer_completed" });
    }

    if (eventType === "call.hangup") {
      if (!targetLeg) {
        // The caller/original leg disappeared while handoff was pending. There is
        // nobody left to play a terminal message to, but callback traceability is preserved.
        if (handoff.phase !== "TRANSFERRED") {
          this.clearTransferWatchdogV37();
          await this.patchHandoffBestEffortV37({
            status: "TERMINATED",
            transfer_ended_at: new Date().toISOString(),
            call_terminated_at: new Date().toISOString(),
            callback_required: true,
            callback_status: "PENDING",
            failure_reason: `SOURCE_CALL_HANGUP:${nonEmpty(event.hangup_cause) ?? "unknown"}`,
          });
        }
        return Response.json({ ok: true, action: "source_hangup_recorded" });
      }

      if (handoff.phase !== "TRANSFERRED" && handoff.phase !== "TERMINATING") {
        const status = classifyHandoffFailure(event.hangup_cause);
        await this.failHandoffV37(status, `TARGET_CALL_HANGUP:${nonEmpty(event.hangup_cause) ?? "unknown"}`);
        return Response.json({ ok: true, action: "transfer_failure_handled", status });
      }
    }

    return Response.json({ ok: true, ignored: true, event_type: eventType });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseRealtimeEvent(data);
    const handoff = this.activeHandoffV37;

    if (!handoff && event?.type === "response.function_call_arguments.done" && event.name === HUMAN_ASSISTANCE) {
      if (await this.beginHumanHandoffV37(event)) return;
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    if (!handoff) {
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    // Point of no return: never forward caller turns or normal model lifecycle to
    // older conversational layers after a configured handoff has been accepted.
    if (event?.type === "session.updated" && handoff.phase === "WAITING_VAD_OFF") {
      if (event.session?.audio?.input?.turn_detection === null) {
        const config = this.humanHandoffConfigV37;
        if (config) this.emitHandoffSpeechV37("ANNOUNCEMENT", config.successMessage);
      }
      return;
    }

    if (event?.type === "response.created") {
      const kind = event.response?.metadata?.[HANDOFF_METADATA_KEY];
      const metadataHandoffId = event.response?.metadata?.handoff_id;
      if ((kind === "ANNOUNCEMENT" || kind === "FAILURE_TERMINAL") && metadataHandoffId === handoff.id) {
        handoff.speechKind = kind;
        handoff.speechResponseId = responseId(event);
        (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_SPEECH_BOUND_V37", {
          handoff_id: handoff.id,
          kind,
          response_id: handoff.speechResponseId,
        });
      }
      return;
    }

    if (event?.type === "output_audio_buffer.stopped" && handoff.speechResponseId && responseId(event) === handoff.speechResponseId) {
      const kind = handoff.speechKind;
      this.clearHandoffSpeechWatchdogV37();
      if (kind === "ANNOUNCEMENT") await this.startTelnyxTransferV37();
      else if (kind === "FAILURE_TERMINAL") await this.terminateAfterHandoffFailureV37("failure_message_playback_completed");
      return;
    }

    if (event?.type === "output_audio_buffer.cleared" && handoff.speechResponseId && responseId(event) === handoff.speechResponseId) {
      if (handoff.speechKind === "ANNOUNCEMENT") await this.failHandoffV37("FAILED", "ANNOUNCEMENT_BUFFER_CLEARED");
      else await this.terminateAfterHandoffFailureV37("failure_message_buffer_cleared");
      return;
    }

    if (event?.type === "response.done" && handoff.speechResponseId && responseId(event) === handoff.speechResponseId && event.response?.status === "failed") {
      if (handoff.speechKind === "ANNOUNCEMENT") await this.failHandoffV37("FAILED", "ANNOUNCEMENT_RESPONSE_FAILED");
      else await this.terminateAfterHandoffFailureV37("failure_message_response_failed");
      return;
    }

    if (event?.type === "error") {
      (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_REALTIME_ERROR_V37", "HANDOFF_REALTIME_ERROR", { handoff_id: handoff.id });
      if (handoff.phase === "ANNOUNCING" || handoff.phase === "WAITING_VAD_OFF") await this.failHandoffV37("FAILED", "REALTIME_ERROR_DURING_ANNOUNCEMENT");
      return;
    }

    if (event?.type === "input_audio_buffer.speech_started" || event?.type === "conversation.item.input_audio_transcription.completed") {
      (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_CALLER_INPUT_IGNORED_V37", {
        handoff_id: handoff.id,
        phase: handoff.phase,
        point_of_no_return: true,
      });
      return;
    }

    // Ignore all other Realtime events during the terminal handoff lifecycle.
  }
}
