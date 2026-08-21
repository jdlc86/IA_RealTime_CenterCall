import { CallSession as CallSessionV36 } from "./call-session-v36";
import { tenantConfigurationKey, tenantConfigurationKeyV2 } from "./tenant-kv";
import {
  classifyHandoffFailure,
  encodeHumanHandoffClientState,
  parseHumanHandoffConfig,
  type HandoffFailureStatus,
  type HumanHandoffConfig,
} from "./human-handoff";
import { HumanHandoffStore } from "./human-handoff-store";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { releaseSemanticGate } from "./semantic-turn-coordinator.js";
import { turnConcurrencyCoordinatorFor } from "./turn-concurrency-coordinator.js";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import {
  humanHandoffTransportRuntimeFor,
  type HumanHandoffSpeechKind,
} from "./human-handoff-transport-runtime.js";
import { humanHandoffTransportPortFor } from "./human-handoff-transport-port.js";
import { callTerminationPortFor } from "./call-termination-port.js";

const BaseConstructor = CallSessionV36 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV36.prototype as any;
const HUMAN_ASSISTANCE = "restaurant_human_assistance";
const HANDOFF_METADATA_KEY = "human_handoff_v37";
const HANDOFF_SPEECH_WATCHDOG_MS = 15_000;
const HANDOFF_TRANSFER_WEBHOOK_GRACE_MS = 10_000;
const ANNOUNCEMENT_PURPOSE = "human_handoff_announcement_v37";
const FAILURE_PURPOSE = "human_handoff_failure_terminal_v37";

type ToolSelectedEvent = Extract<RealtimeProviderEvent, { type: "SEMANTIC_TOOL_SELECTED" }>;
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

function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
  return parsed as Record<string, unknown>;
}
function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function speechKindFromPurpose(purpose: string | undefined): HumanHandoffSpeechKind | null {
  if (purpose === ANNOUNCEMENT_PURPOSE) return "ANNOUNCEMENT";
  if (purpose === FAILURE_PURPOSE) return "FAILURE_TERMINAL";
  return null;
}

/**
 * v37 coordinates human handoff through provider-neutral realtime, transfer and
 * termination ports. Shared handoff state, transport context and watchdogs are
 * not owned by this CallSession generation; provider credentials/endpoints stay
 * behind the transport ports.
 */
export class CallSession extends BaseConstructor {
  private handoffRuntimeV37() {
    return humanHandoffTransportRuntimeFor(this);
  }

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
      } catch {}
    }
    const response = await super.fetch(request);
    if (isStart && response.ok && tenantIdFromStart) await this.loadHumanHandoffConfigV37(tenantIdFromStart);
    return response;
  }

  private storeV37(): HumanHandoffStore {
    const env = (this as any).env ?? {};
    return new HumanHandoffStore({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY });
  }

  private async loadHumanHandoffConfigV37(tenantId: string): Promise<void> {
    const session = this as any;
    const runtime = this.handoffRuntimeV37();
    const kv = session.env?.TENANT_CONFIG;
    if (!kv || typeof kv.get !== "function") return;
    try {
      const raw = await kv.get(tenantConfigurationKeyV2(tenantId), { cacheTtl: 30 })
        ?? await kv.get(tenantConfigurationKey(tenantId), { cacheTtl: 30 });
      if (!raw) return;
      const record = JSON.parse(raw) as Record<string, unknown>;
      const config = parseHumanHandoffConfig(record.humanHandoff);
      runtime.setConfig(config);
      session.diagnostics?.checkpoint?.("HUMAN_HANDOFF_CONFIG_LOADED_V37", {
        configured: config !== undefined,
        enabled: config?.enabled === true,
        destination_type: config?.destination.type ?? null,
        destination_label: config?.destination.label ?? null,
        destination_phone_exposed_to_model: false,
        state_owner: "human_handoff_transport_runtime",
      });
    } catch (error) {
      runtime.setConfig(undefined);
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
    const sourceCallControlId = nonEmpty(body.telnyx_call_control_id);
    const calledNumber = nonEmpty(body.called_number);
    if (!sourceCallControlId || !calledNumber) {
      return Response.json({ ok: false, error: "missing_transport_context" }, { status: 400 });
    }

    this.handoffRuntimeV37().attachTransportContext(sourceCallControlId, calledNumber);
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TRANSPORT_CONTEXT_ATTACHED_V37", {
      telnyx_call_control_id_present: true,
      called_number_present: true,
      state_owner: "human_handoff_transport_runtime",
    });
    return Response.json({ ok: true });
  }

  private handoffPrerequisitesV37(): {
    tenantId: string;
    callId: string;
    callerPhone: string;
    sourceCallControlId: string;
    calledNumber: string;
    config: HumanHandoffConfig;
  } | null {
    const session = this as any;
    const runtime = this.handoffRuntimeV37();
    const config = runtime.getConfig();
    if (!config?.enabled) return null;
    const context = runtime.transportContext();
    const tenantId = nonEmpty(session.tenantId);
    const callId = nonEmpty(session.callId);
    const callerPhone = nonEmpty(session.callerPhone);
    const sourceCallControlId = nonEmpty(context.sourceCallControlId);
    const calledNumber = nonEmpty(context.calledNumber);
    if (!tenantId || !callId || !callerPhone || !sourceCallControlId || !calledNumber || !session.socket) return null;
    return { tenantId, callId, callerPhone, sourceCallControlId, calledNumber, config };
  }

  private async beginHumanHandoffV37(event: ToolSelectedEvent): Promise<boolean> {
    const runtime = this.handoffRuntimeV37();
    const prerequisites = this.handoffPrerequisitesV37();
    if (!prerequisites || runtime.snapshot() || !event.callId) return false;

    let args: Record<string, unknown>;
    try { args = parseToolArgs(event.arguments); }
    catch { return false; }
    const reason = nonEmpty(args.reason) ?? "HUMAN_ASSISTANCE_REQUIRED";
    const summary = nonEmpty(args.context_summary)?.slice(0, 500);
    const handoffId = crypto.randomUUID();

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

    if (!runtime.begin({ id: handoffId, reason, summary })) return false;
    releaseSemanticGate(this, HUMAN_ASSISTANCE);
    conversationLifecyclePortFor(this).humanHandoffStarted();
    turnConcurrencyCoordinatorFor(this).detachForTerminal(this as any, "human_handoff_v37");

    const commands = realtimeCommandPortFor(this as any);
    commands.submitToolResult({
      callId: event.callId,
      toolName: HUMAN_ASSISTANCE,
      output: {
        ok: true,
        status: "HUMAN_HANDOFF_ACCEPTED",
        handoff_id: handoffId,
        transfer_available: true,
        callback_on_failure: true,
        terminal_lifecycle: true,
      },
    });

    await this.patchHandoffBestEffortV37({ status: "ANNOUNCING" });
    try {
      commands.clearInput();
      commands.suspendInputDetection();
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
      semantic_gate_owner: "semantic_turn_coordinator",
      lifecycle_owner: "conversation_lifecycle_port",
      turn_concurrency_owner: "turn_concurrency_coordinator",
      state_owner: "human_handoff_transport_runtime",
      provider_boundary: "realtime_provider_runtime",
    });
    return true;
  }

  private emitHandoffSpeechV37(kind: HumanHandoffSpeechKind, text: string): void {
    const runtime = this.handoffRuntimeV37();
    const handoff = runtime.beginSpeech(kind);
    if (!handoff) return;
    const purpose = kind === "ANNOUNCEMENT" ? ANNOUNCEMENT_PURPOSE : FAILURE_PURPOSE;
    realtimeCommandPortFor(this as any).speak({
      requestId: `human_handoff_${crypto.randomUUID()}`,
      instructions: `Pronuncia exactamente esta frase y nada más: ${JSON.stringify(text)}`,
      exactText: text,
      isolated: true,
      tools: "DISABLED",
      purpose,
      metadata: { [HANDOFF_METADATA_KEY]: kind, handoff_id: handoff.id },
    });
    this.armHandoffSpeechWatchdogV37(kind);
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_PROTECTED_SPEECH_REQUESTED_V37", {
      handoff_id: handoff.id,
      kind,
      vad_disabled: true,
      exact_speech: true,
      provider_boundary: "realtime_provider_runtime",
    });
  }

  private armHandoffSpeechWatchdogV37(kind: HumanHandoffSpeechKind): void {
    const runtime = this.handoffRuntimeV37();
    runtime.armSpeechWatchdog(HANDOFF_SPEECH_WATCHDOG_MS, () => {
      const handoff = runtime.snapshot();
      if (!handoff || handoff.speechKind !== kind) return;
      if (kind === "ANNOUNCEMENT") void this.failHandoffV37("FAILED", "ANNOUNCEMENT_PLAYBACK_TIMEOUT");
      else void this.terminateAfterHandoffFailureV37("failure_message_playback_timeout");
    });
  }

  private armTransferWatchdogV37(): void {
    const runtime = this.handoffRuntimeV37();
    const timeoutMs = ((runtime.getConfig()?.transfer.answerTimeoutSeconds ?? 25) * 1000) + HANDOFF_TRANSFER_WEBHOOK_GRACE_MS;
    runtime.armTransferWatchdog(timeoutMs, () => {
      if (runtime.snapshot()?.phase === "DIALING") void this.failHandoffV37("FAILED", "TRANSFER_RESULT_WEBHOOK_TIMEOUT");
    });
  }

  private async startTelnyxTransferV37(): Promise<void> {
    const runtime = this.handoffRuntimeV37();
    const handoff = runtime.snapshot();
    const prerequisites = this.handoffPrerequisitesV37();
    if (!handoff || !prerequisites || handoff.phase !== "ANNOUNCING") return;

    runtime.cancelSpeechWatchdog();
    runtime.clearSpeech("DIALING");
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
      const transfer = await humanHandoffTransportPortFor(this as any).startTransfer({
        sourceCallControlId: prerequisites.sourceCallControlId,
        destinationPhone: prerequisites.config.destination.phone,
        originatingNumber: prerequisites.calledNumber,
        answerTimeoutSeconds: prerequisites.config.transfer.answerTimeoutSeconds,
        commandId: `${handoff.id}-human-transfer`,
        correlationState: state,
      });
      if (!transfer.started) throw new Error(transfer.error ?? "HUMAN_HANDOFF_TRANSFER_NOT_STARTED");
      this.armTransferWatchdogV37();
      (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TRANSFER_STARTED_V37", {
        handoff_id: handoff.id,
        destination_label: prerequisites.config.destination.label,
        answer_timeout_seconds: prerequisites.config.transfer.answerTimeoutSeconds,
        destination_phone_exposed_to_model: false,
        state_owner: "human_handoff_transport_runtime",
        physical_transfer_owner: "human_handoff_transport_port",
      });
    } catch (error) {
      await this.failHandoffV37("FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async patchHandoffBestEffortV37(patch: Parameters<HumanHandoffStore["update"]>[2]): Promise<void> {
    const handoff = this.handoffRuntimeV37().snapshot();
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
    const runtime = this.handoffRuntimeV37();
    const handoff = runtime.snapshot();
    const config = runtime.getConfig();
    if (!handoff || !config || handoff.phase === "TRANSFERRED" || handoff.phase === "TERMINATING") return;
    runtime.cancelTransferWatchdog();
    runtime.cancelSpeechWatchdog();
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
    const runtime = this.handoffRuntimeV37();
    const handoff = runtime.beginTerminating();
    if (!handoff) return;
    const sourceCallControlId = runtime.transportContext().sourceCallControlId;
    const callId = nonEmpty((this as any).callId);
    const termination = await callTerminationPortFor(this as any).terminate({
      sourceCallControlId,
      realtimeCallId: callId,
      commandId: `${handoff.id}-terminal-hangup`,
    });

    for (const attempt of termination.attempts) {
      if (attempt.ok) continue;
      if (attempt.transport === "TELNYX_SOURCE_LEG") {
        (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_TELNYX_HANGUP_FAILED_V37", "TELNYX_TERMINAL_HANGUP_FAILED", {
          handoff_id: handoff.id,
          error: attempt.error ?? "unknown",
          physical_termination_owner: "call_termination_port",
        });
      } else {
        (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_OPENAI_HANGUP_FAILED_V37", "OPENAI_TERMINAL_HANGUP_FAILED", {
          handoff_id: handoff.id,
          error: attempt.error ?? "unknown",
          physical_termination_owner: "call_termination_port",
        });
      }
    }

    await this.patchHandoffBestEffortV37({ call_terminated_at: new Date().toISOString() });
    conversationLifecyclePortFor(this).transportClosed("human_handoff_terminal");
    try { (this as any).socket?.close?.(1000, "human_handoff_terminal"); } catch {}
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TERMINAL_CALL_ENDED_V37", {
      handoff_id: handoff.id,
      trigger,
      telephony_terminated: termination.terminated,
      termination_attempts: termination.attempts.map((attempt) => ({ transport: attempt.transport, ok: attempt.ok })),
      lucia_conversation_resumes: false,
      lifecycle_owner: "conversation_lifecycle_port",
      physical_termination_owner: "call_termination_port",
      direct_runtime_closing_mutation: false,
    });
  }

  private async handleTelnyxHandoffEventV37(request: Request): Promise<Response> {
    let event: HandoffTelnyxEvent;
    try { event = await request.json() as HandoffTelnyxEvent; }
    catch { return Response.json({ ok: false, error: "invalid_json" }, { status: 400 }); }

    const runtime = this.handoffRuntimeV37();
    let handoff = runtime.snapshot();
    if (!handoff) return Response.json({ ok: true, ignored: true, reason: "no_active_handoff" });
    const context = runtime.transportContext();
    const handoffId = nonEmpty(event.handoff_id);
    const realtimeCallId = nonEmpty(event.realtime_call_id);
    const tenantId = nonEmpty(event.tenant_id);
    const sourceCallControlId = nonEmpty(event.source_call_control_id);
    if (
      handoffId !== handoff.id
      || realtimeCallId !== nonEmpty((this as any).callId)
      || tenantId !== nonEmpty((this as any).tenantId)
      || sourceCallControlId !== context.sourceCallControlId
    ) {
      return Response.json({ ok: true, ignored: true, reason: "handoff_correlation_mismatch" });
    }

    const eventType = nonEmpty(event.event_type) ?? "unknown";
    const eventCallControlId = nonEmpty(event.call_control_id);
    const targetLeg = Boolean(eventCallControlId && eventCallControlId !== sourceCallControlId);
    if (targetLeg && eventCallControlId && !handoff.targetCallControlId) {
      runtime.setTargetCallControlId(eventCallControlId);
      await this.patchHandoffBestEffortV37({ target_call_control_id: eventCallControlId });
      handoff = runtime.snapshot()!;
    }

    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_TELNYX_EVENT_V37", {
      handoff_id: handoff.id,
      event_type: eventType,
      target_leg: targetLeg,
      phase: handoff.phase,
      state_owner: "human_handoff_transport_runtime",
    });

    if (eventType === "call.answered" && targetLeg && handoff.phase === "DIALING") {
      await this.patchHandoffBestEffortV37({
        status: "ANSWERED",
        answered_at: new Date().toISOString(),
        target_call_control_id: eventCallControlId,
      });
      return Response.json({ ok: true, action: "answered_recorded" });
    }

    if (eventType === "call.bridged" && handoff.phase === "DIALING") {
      await humanHandoffTransportPortFor(this).markTransferred(eventCallControlId);
      return Response.json({ ok: true, action: "transfer_completed" });
    }

    if (eventType === "call.hangup") {
      if (!targetLeg) {
        if (handoff.phase !== "TRANSFERRED") {
          runtime.cancelTransferWatchdog();
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
    const events = adaptRealtimeProviderEvents(data);
    const runtime = this.handoffRuntimeV37();
    if (!runtime.snapshot()) {
      const handoffTool = events.find(
        (event): event is ToolSelectedEvent => event.type === "SEMANTIC_TOOL_SELECTED" && event.name === HUMAN_ASSISTANCE,
      );
      if (handoffTool && await this.beginHumanHandoffV37(handoffTool)) return;
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    for (const event of events) {
      let handoff = runtime.snapshot();
      if (!handoff) break;

      if (
        event.type === "INPUT_DETECTION_UPDATED"
        && handoff.phase === "WAITING_VAD_OFF"
        && event.present
        && event.settings === null
      ) {
        const config = runtime.getConfig();
        if (config) this.emitHandoffSpeechV37("ANNOUNCEMENT", config.successMessage);
        continue;
      }

      if (event.type === "ASSISTANT_RESPONSE_STARTED" && event.responseId) {
        const kind = speechKindFromPurpose(event.purpose);
        if (kind && event.kind === "HANDOFF" && kind === handoff.speechKind && runtime.bindSpeechResponse(kind, event.responseId)) {
          (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_SPEECH_BOUND_V37", {
            handoff_id: handoff.id,
            kind,
            response_id: event.responseId,
            provider_event_adapter: true,
          });
        }
        continue;
      }

      handoff = runtime.snapshot();
      if (!handoff) continue;
      const matchesSpeech = Boolean(handoff.speechResponseId && "responseId" in event && event.responseId === handoff.speechResponseId);

      if (event.type === "ASSISTANT_AUDIO_STOPPED" && matchesSpeech) {
        const kind = handoff.speechKind;
        runtime.cancelSpeechWatchdog();
        if (kind === "ANNOUNCEMENT") await this.startTelnyxTransferV37();
        else if (kind === "FAILURE_TERMINAL") await this.terminateAfterHandoffFailureV37("failure_message_playback_completed");
        continue;
      }

      if (event.type === "ASSISTANT_AUDIO_CLEARED" && matchesSpeech) {
        if (handoff.speechKind === "ANNOUNCEMENT") await this.failHandoffV37("FAILED", "ANNOUNCEMENT_BUFFER_CLEARED");
        else await this.terminateAfterHandoffFailureV37("failure_message_buffer_cleared");
        continue;
      }

      if (event.type === "ASSISTANT_RESPONSE_COMPLETED" && matchesSpeech && event.status === "failed") {
        if (handoff.speechKind === "ANNOUNCEMENT") await this.failHandoffV37("FAILED", "ANNOUNCEMENT_RESPONSE_FAILED");
        else await this.terminateAfterHandoffFailureV37("failure_message_response_failed");
        continue;
      }

      if (event.type === "PROVIDER_COMMAND_FAILED") {
        (this as any).diagnostics?.fail?.("HUMAN_HANDOFF_REALTIME_ERROR_V37", "HANDOFF_REALTIME_ERROR", {
          handoff_id: handoff.id,
          provider_error_code: event.code ?? null,
        });
        if (handoff.phase === "ANNOUNCING" || handoff.phase === "WAITING_VAD_OFF") {
          await this.failHandoffV37("FAILED", "REALTIME_ERROR_DURING_ANNOUNCEMENT");
        }
        continue;
      }

      if (event.type === "CALLER_SPEECH_STARTED" || event.type === "CALLER_TRANSCRIPT_COMPLETED") {
        (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_CALLER_INPUT_IGNORED_V37", {
          handoff_id: handoff.id,
          phase: handoff.phase,
          point_of_no_return: true,
        });
      }
    }
  }
}
