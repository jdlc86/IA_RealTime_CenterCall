import { CallSession as CallSessionV35 } from "./call-session-v35";
import { KvTenantRepository } from "./tenant-kv";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event";
import { inputDetectionConfigRuntimeFor } from "./input-detection-config-runtime.js";
import { sessionTaskRuntimeFor } from "./session-task-runtime.js";

const BaseConstructor = CallSessionV35 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV35.prototype as any;
const CALLSESSION_RUNTIME_FINGERPRINT = "v35-protected-speech-runtime-2026-08-15-c";
const ATOMIC_GREETING_WATCHDOG_MS = 30_000;
const PROTECTED_METADATA_KEY = "protected_speech_v35";

/** Compatibility adapter for protected greeting; shared VAD config is version-neutral. */
export class CallSession extends BaseConstructor {
  private atomicGreetingActiveV35 = false;
  private atomicGreetingAwaitingVadOffV35 = false;
  private atomicGreetingResponseIdV35: string | null = null;
  private atomicGreetingInstructionsV35: string | null = null;
  private atomicGreetingExactTextV35: string | null = null;
  private atomicGreetingWatchdogV35: ReturnType<typeof setTimeout> | null = null;
  private awaitingVadRestoreConfirmationV35 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    if (isStart) {
      try {
        const body = await request.clone().json() as { tenant_id?: unknown };
        const tenantId = typeof body.tenant_id === "string" ? body.tenant_id.trim() : "";
        const kv = (this as any).env?.TENANT_CONFIG;
        if (tenantId && kv && typeof kv.get === "function") {
          const config = await new KvTenantRepository(kv).getTenantConfiguration(tenantId);
          inputDetectionConfigRuntimeFor(this).set(config?.realtime.vad ?? {});
        } else {
          inputDetectionConfigRuntimeFor(this).set({});
        }
      } catch {
        inputDetectionConfigRuntimeFor(this).set({});
      }
    }

    const response = await super.fetch(request);
    if (isStart && response.ok) {
      (this as any).diagnostics?.checkpoint?.("CALLSESSION_RUNTIME_FINGERPRINT_V35", {
        fingerprint: CALLSESSION_RUNTIME_FINGERPRINT,
        atomic_greeting_vad_suspension: true,
        provider_command_port: true,
        provider_event_adapter: true,
        input_detection_config_owner: "input_detection_config_runtime",
      });
    }
    return response;
  }

  private commandsV35() { return realtimeCommandPortFor(this as any); }

  private sendInitialGreetingIfNeeded(): void {
    const session = this as any;
    if (session.greetingSent || !session.socket || !session.initialGreeting || !session.callId) return;
    if (this.atomicGreetingActiveV35) return;
    this.atomicGreetingActiveV35 = true;
    this.atomicGreetingAwaitingVadOffV35 = true;
    this.atomicGreetingExactTextV35 = String(session.initialGreeting);
    this.atomicGreetingInstructionsV35 = `Pronuncia exactamente este saludo inicial y nada más: ${JSON.stringify(this.atomicGreetingExactTextV35)}`;
    session.greetingSent = true;
    this.commandsV35().suspendInputDetection();
    this.armAtomicGreetingWatchdogV35();
    session.diagnostics?.checkpoint?.("ATOMIC_GREETING_VAD_SUSPEND_REQUESTED_V35", { turn_detection: null, provider_command_port: true });
    session.diagnostics?.checkpoint?.("GREETING_SENT", { protected_speech: true, playback_pending_until_vad_disabled: true });
  }

  private emitAtomicGreetingAfterVadDisabledV35(): void {
    if (!this.atomicGreetingActiveV35 || !this.atomicGreetingAwaitingVadOffV35 || !this.atomicGreetingInstructionsV35 || !this.atomicGreetingExactTextV35) return;
    this.atomicGreetingAwaitingVadOffV35 = false;
    const clientEventId = `atomic_greeting_v35_${crypto.randomUUID()}`;
    this.commandsV35().speak({
      requestId: clientEventId,
      tools: "DISABLED",
      instructions: this.atomicGreetingInstructionsV35,
      exactText: this.atomicGreetingExactTextV35,
      metadata: { [PROTECTED_METADATA_KEY]: "GREETING" },
    });
    (this as any).diagnostics?.checkpoint?.("ATOMIC_GREETING_RESPONSE_REQUESTED_V35", { vad_confirmed_disabled: true, provider_command_port: true });
  }

  private finishAtomicGreetingV35(reason: string, abnormal = false): void {
    if (!this.atomicGreetingActiveV35) return;
    this.clearAtomicGreetingWatchdogV35();
    const session = this as any;
    try {
      if (session.socket) {
        const commands = this.commandsV35();
        commands.clearInput();
        commands.restoreInputDetection(inputDetectionConfigRuntimeFor(this).get());
        this.awaitingVadRestoreConfirmationV35 = true;
      }
    } catch (error) {
      session.diagnostics?.fail?.("ATOMIC_GREETING_VAD_RESTORE_FAILED_V35", "VAD_RESTORE_SEND_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (abnormal) {
      session.diagnostics?.fail?.("ATOMIC_GREETING_TERMINATED_ABNORMALLY_V35", "PROTECTED_GREETING_AUDIO_NOT_DRAINED", {
        reason, response_id: this.atomicGreetingResponseIdV35,
      });
    }
    session.diagnostics?.checkpoint?.("ATOMIC_GREETING_COMPLETED_V35", {
      reason, response_id: this.atomicGreetingResponseIdV35,
      input_buffer_cleared_before_vad_restore: true,
      vad_restore_requested: Boolean(session.socket), provider_command_port: true,
    });
    this.atomicGreetingActiveV35 = false;
    this.atomicGreetingAwaitingVadOffV35 = false;
    this.atomicGreetingResponseIdV35 = null;
    this.atomicGreetingInstructionsV35 = null;
    this.atomicGreetingExactTextV35 = null;
  }

  private armAtomicGreetingWatchdogV35(): void {
    this.clearAtomicGreetingWatchdogV35();
    this.atomicGreetingWatchdogV35 = setTimeout(() => {
      sessionTaskRuntimeFor(this).enqueue("atomic_greeting_watchdog_v35", () => {
        if (!this.atomicGreetingActiveV35) return;
        (this as any).diagnostics?.fail?.("ATOMIC_GREETING_WATCHDOG_V35", "ATOMIC_GREETING_TERMINAL_EVENT_MISSING", {
          watchdog_ms: ATOMIC_GREETING_WATCHDOG_MS,
          awaiting_vad_off: this.atomicGreetingAwaitingVadOffV35,
          response_id: this.atomicGreetingResponseIdV35,
        });
        this.finishAtomicGreetingV35("atomic_greeting_watchdog", true);
      });
    }, ATOMIC_GREETING_WATCHDOG_MS);
  }

  private clearAtomicGreetingWatchdogV35(): void {
    if (!this.atomicGreetingWatchdogV35) return;
    clearTimeout(this.atomicGreetingWatchdogV35);
    this.atomicGreetingWatchdogV35 = null;
  }

  private traceInputDetectionV35(event: Extract<RealtimeProviderEvent, { type: "INPUT_DETECTION_UPDATED" }>): void {
    const settings = event.settings;
    (this as any).diagnostics?.checkpoint?.("REALTIME_TURN_DETECTION_EFFECTIVE_V35", {
      provider_event: event.type, turn_detection_present: event.present,
      turn_detection_disabled: event.present && settings === null,
      turn_detection_type: settings === null ? null : "provider_managed",
      interrupt_response: settings?.interruptResponse ?? null,
      create_response: settings?.createResponse ?? null,
      threshold: settings?.threshold ?? null,
      prefix_padding_ms: settings?.prefixPaddingMs ?? null,
      silence_duration_ms: settings?.silenceDurationMs ?? null,
      idle_timeout_ms: settings?.idleTimeoutMs ?? null,
      provider_neutral_observation: true,
    });
  }

  private handleNeutralEventV35(event: RealtimeProviderEvent): void {
    if (event.type === "INPUT_DETECTION_UPDATED") {
      this.traceInputDetectionV35(event);
      if (this.atomicGreetingActiveV35 && this.atomicGreetingAwaitingVadOffV35 && event.present && event.settings === null) {
        (this as any).diagnostics?.checkpoint?.("ATOMIC_GREETING_VAD_DISABLED_CONFIRMED_V35", {});
        this.emitAtomicGreetingAfterVadDisabledV35();
      }
      if (this.awaitingVadRestoreConfirmationV35 && event.present && event.settings !== null) {
        this.awaitingVadRestoreConfirmationV35 = false;
        (this as any).diagnostics?.checkpoint?.("ATOMIC_GREETING_VAD_RESTORED_CONFIRMED_V35", {
          type: "provider_managed",
          interrupt_response: event.settings.interruptResponse ?? null,
          create_response: event.settings.createResponse ?? null,
        });
      }
      return;
    }
    if (event.type === "ASSISTANT_RESPONSE_STARTED" && this.atomicGreetingActiveV35 && event.kind === "GREETING") {
      this.atomicGreetingResponseIdV35 = event.responseId ?? null;
      (this as any).diagnostics?.checkpoint?.("ATOMIC_GREETING_RESPONSE_BOUND_V35", { response_id: this.atomicGreetingResponseIdV35, metadata_confirmed: true });
      return;
    }
    if (event.type === "ASSISTANT_AUDIO_STARTED" && this.atomicGreetingActiveV35) {
      if (event.responseId && event.responseId === this.atomicGreetingResponseIdV35) {
        (this as any).diagnostics?.checkpoint?.("ATOMIC_GREETING_PLAYBACK_STARTED_V35", { response_id: event.responseId });
      }
      return;
    }
    if (event.type === "ASSISTANT_AUDIO_STOPPED" && this.atomicGreetingActiveV35) {
      if (event.responseId && event.responseId === this.atomicGreetingResponseIdV35) this.finishAtomicGreetingV35("assistant_audio_stopped");
      return;
    }
    if (event.type === "ASSISTANT_AUDIO_CLEARED" && this.atomicGreetingActiveV35) {
      if (event.responseId && event.responseId === this.atomicGreetingResponseIdV35) this.finishAtomicGreetingV35("assistant_audio_cleared", true);
      return;
    }
    if (event.type === "ASSISTANT_RESPONSE_COMPLETED" && this.atomicGreetingActiveV35) {
      if (event.responseId && event.responseId === this.atomicGreetingResponseIdV35 && event.status === "failed") {
        this.finishAtomicGreetingV35("response_failed", true);
      }
      return;
    }
    if (event.type === "CALLER_SPEECH_STARTED") {
      (this as any).diagnostics?.checkpoint?.("CALLER_SPEECH_DURING_ATOMIC_GREETING_V35", {
        atomic_greeting_active: this.atomicGreetingActiveV35,
        awaiting_vad_off: this.atomicGreetingAwaitingVadOffV35,
        response_id: this.atomicGreetingResponseIdV35,
      });
    }
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    for (const event of adaptRealtimeProviderEvents(data)) this.handleNeutralEventV35(event);
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
