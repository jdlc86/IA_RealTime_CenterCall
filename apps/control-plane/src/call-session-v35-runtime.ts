import { CallSession as CallSessionV35 } from "./call-session-v35";
import { KvTenantRepository } from "./tenant-kv";
import { realtimeCommandPortFor } from "./openai-realtime-command-adapter";
import type { RealtimeInputDetectionSettings } from "./realtime-provider-command-port";

const BaseConstructor = CallSessionV35 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV35.prototype as any;
const CALLSESSION_RUNTIME_FINGERPRINT = "v35-protected-speech-runtime-2026-08-15-c";
const ATOMIC_GREETING_WATCHDOG_MS = 30_000;
const PROTECTED_METADATA_KEY = "protected_speech_v35";

type TurnDetection = {
  type?: string;
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
  idle_timeout_ms?: number;
  create_response?: boolean;
  interrupt_response?: boolean;
} | null;

type RealtimeSessionEvent = {
  type?: string;
  response_id?: string;
  response?: {
    id?: string;
    status?: string;
    metadata?: Record<string, unknown> | null;
  };
  session?: {
    audio?: {
      input?: {
        turn_detection?: TurnDetection;
      };
    };
  };
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseRealtimeEvent(data: unknown): RealtimeSessionEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try {
    return JSON.parse(text) as RealtimeSessionEvent;
  } catch {
    return null;
  }
}

function responseId(event: RealtimeSessionEvent): string | null {
  return event.response_id ?? event.response?.id ?? null;
}

/**
 * Validation layer for atomic greeting playback.
 *
 * Root-cause evidence from production showed that SIP emitted
 * output_audio_buffer.cleared at the same instant as VAD speech_started even
 * while interrupt_response=false. For the initial greeting we therefore remove
 * turn detection completely, wait for the server to confirm it is disabled,
 * emit the greeting, wait for actual playback completion, discard any caller
 * audio accumulated during the protected window, and then restore the tenant's
 * normal input-detection configuration through the provider command boundary.
 *
 * This layer does not classify caller intent and does not change normal turns.
 */
export class CallSession extends BaseConstructor {
  private tenantVadV35: RealtimeInputDetectionSettings = {};
  private atomicGreetingActiveV35 = false;
  private atomicGreetingAwaitingVadOffV35 = false;
  private atomicGreetingResponseIdV35: string | null = null;
  private atomicGreetingInstructionsV35: string | null = null;
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
          this.tenantVadV35 = config?.realtime.vad ?? {};
        }
      } catch {
        this.tenantVadV35 = {};
      }
    }

    const response = await super.fetch(request);

    if (isStart && response.ok) {
      (this as any).diagnostics?.checkpoint?.("CALLSESSION_RUNTIME_FINGERPRINT_V35", {
        fingerprint: CALLSESSION_RUNTIME_FINGERPRINT,
        atomic_greeting_vad_suspension: true,
        provider_command_port: true,
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
    this.atomicGreetingInstructionsV35 =
      `Pronuncia exactamente este saludo inicial y nada más: ${JSON.stringify(session.initialGreeting)}`;
    session.greetingSent = true;

    this.commandsV35().suspendInputDetection();
    this.armAtomicGreetingWatchdogV35();

    session.diagnostics?.checkpoint?.("ATOMIC_GREETING_VAD_SUSPEND_REQUESTED_V35", {
      turn_detection: null,
      provider_command_port: true,
    });
    session.diagnostics?.checkpoint?.("GREETING_SENT", {
      protected_speech: true,
      playback_pending_until_vad_disabled: true,
    });
  }

  private emitAtomicGreetingAfterVadDisabledV35(): void {
    if (!this.atomicGreetingActiveV35 || !this.atomicGreetingAwaitingVadOffV35) return;
    if (!this.atomicGreetingInstructionsV35) return;

    this.atomicGreetingAwaitingVadOffV35 = false;
    const clientEventId = `atomic_greeting_v35_${crypto.randomUUID()}`;
    this.commandsV35().speak({
      requestId: clientEventId,
      tools: "DISABLED",
      instructions: this.atomicGreetingInstructionsV35,
      metadata: { [PROTECTED_METADATA_KEY]: "GREETING" },
    });
    (this as any).diagnostics?.checkpoint?.("ATOMIC_GREETING_RESPONSE_REQUESTED_V35", {
      vad_confirmed_disabled: true,
      provider_command_port: true,
    });
  }

  private finishAtomicGreetingV35(reason: string, abnormal = false): void {
    if (!this.atomicGreetingActiveV35) return;
    this.clearAtomicGreetingWatchdogV35();

    const session = this as any;
    try {
      if (session.socket) {
        // Caller speech during the protected greeting is intentionally not a
        // conversational turn. Drop buffered input before re-enabling detection.
        const commands = this.commandsV35();
        commands.clearInput();
        commands.restoreInputDetection(this.tenantVadV35);
        this.awaitingVadRestoreConfirmationV35 = true;
      }
    } catch (error) {
      session.diagnostics?.fail?.("ATOMIC_GREETING_VAD_RESTORE_FAILED_V35", "VAD_RESTORE_SEND_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (abnormal) {
      session.diagnostics?.fail?.("ATOMIC_GREETING_TERMINATED_ABNORMALLY_V35", "PROTECTED_GREETING_AUDIO_NOT_DRAINED", {
        reason,
        response_id: this.atomicGreetingResponseIdV35,
      });
    }

    session.diagnostics?.checkpoint?.("ATOMIC_GREETING_COMPLETED_V35", {
      reason,
      response_id: this.atomicGreetingResponseIdV35,
      input_buffer_cleared_before_vad_restore: true,
      vad_restore_requested: Boolean(session.socket),
      provider_command_port: true,
    });

    this.atomicGreetingActiveV35 = false;
    this.atomicGreetingAwaitingVadOffV35 = false;
    this.atomicGreetingResponseIdV35 = null;
    this.atomicGreetingInstructionsV35 = null;
  }

  private armAtomicGreetingWatchdogV35(): void {
    this.clearAtomicGreetingWatchdogV35();
    this.atomicGreetingWatchdogV35 = setTimeout(() => {
      if (!this.atomicGreetingActiveV35) return;
      (this as any).diagnostics?.fail?.("ATOMIC_GREETING_WATCHDOG_V35", "ATOMIC_GREETING_TERMINAL_EVENT_MISSING", {
        watchdog_ms: ATOMIC_GREETING_WATCHDOG_MS,
        awaiting_vad_off: this.atomicGreetingAwaitingVadOffV35,
        response_id: this.atomicGreetingResponseIdV35,
      });
      this.finishAtomicGreetingV35("atomic_greeting_watchdog", true);
    }, ATOMIC_GREETING_WATCHDOG_MS);
  }

  private clearAtomicGreetingWatchdogV35(): void {
    if (!this.atomicGreetingWatchdogV35) return;
    clearTimeout(this.atomicGreetingWatchdogV35);
    this.atomicGreetingWatchdogV35 = null;
  }

  private traceTurnDetectionV35(event: RealtimeSessionEvent): void {
    const turnDetection = event.session?.audio?.input?.turn_detection;
    (this as any).diagnostics?.checkpoint?.("REALTIME_TURN_DETECTION_EFFECTIVE_V35", {
      event_type: event.type,
      turn_detection_present: turnDetection !== undefined,
      turn_detection_disabled: turnDetection === null,
      turn_detection_type: turnDetection && typeof turnDetection === "object" ? turnDetection.type ?? null : null,
      interrupt_response: turnDetection && typeof turnDetection === "object" ? turnDetection.interrupt_response ?? null : null,
      create_response: turnDetection && typeof turnDetection === "object" ? turnDetection.create_response ?? null : null,
      threshold: turnDetection && typeof turnDetection === "object" ? turnDetection.threshold ?? null : null,
      prefix_padding_ms: turnDetection && typeof turnDetection === "object" ? turnDetection.prefix_padding_ms ?? null : null,
      silence_duration_ms: turnDetection && typeof turnDetection === "object" ? turnDetection.silence_duration_ms ?? null : null,
      idle_timeout_ms: turnDetection && typeof turnDetection === "object" ? turnDetection.idle_timeout_ms ?? null : null,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseRealtimeEvent(data);

    if (event?.type === "session.created" || event?.type === "session.updated") {
      this.traceTurnDetectionV35(event);
      const turnDetection = event.session?.audio?.input?.turn_detection;

      if (this.atomicGreetingActiveV35 && this.atomicGreetingAwaitingVadOffV35 && turnDetection === null) {
        (this as any).diagnostics?.checkpoint?.("ATOMIC_GREETING_VAD_DISABLED_CONFIRMED_V35", {});
        this.emitAtomicGreetingAfterVadDisabledV35();
      }

      if (this.awaitingVadRestoreConfirmationV35 && turnDetection && typeof turnDetection === "object") {
        this.awaitingVadRestoreConfirmationV35 = false;
        (this as any).diagnostics?.checkpoint?.("ATOMIC_GREETING_VAD_RESTORED_CONFIRMED_V35", {
          type: turnDetection.type ?? null,
          interrupt_response: turnDetection.interrupt_response ?? null,
          create_response: turnDetection.create_response ?? null,
        });
      }
    }

    if (event?.type === "response.created" && this.atomicGreetingActiveV35) {
      const metadataKind = event.response?.metadata?.[PROTECTED_METADATA_KEY];
      if (metadataKind === "GREETING") {
        this.atomicGreetingResponseIdV35 = responseId(event);
        (this as any).diagnostics?.checkpoint?.("ATOMIC_GREETING_RESPONSE_BOUND_V35", {
          response_id: this.atomicGreetingResponseIdV35,
          metadata_confirmed: true,
        });
      }
    }

    if (event?.type === "output_audio_buffer.started" && this.atomicGreetingActiveV35) {
      const id = responseId(event);
      if (id && id === this.atomicGreetingResponseIdV35) {
        (this as any).diagnostics?.checkpoint?.("ATOMIC_GREETING_PLAYBACK_STARTED_V35", { response_id: id });
      }
    }

    if (event?.type === "output_audio_buffer.stopped" && this.atomicGreetingActiveV35) {
      const id = responseId(event);
      if (id && id === this.atomicGreetingResponseIdV35) {
        this.finishAtomicGreetingV35("output_audio_buffer_stopped");
      }
    }

    if (event?.type === "output_audio_buffer.cleared" && this.atomicGreetingActiveV35) {
      const id = responseId(event);
      if (id && id === this.atomicGreetingResponseIdV35) {
        this.finishAtomicGreetingV35("output_audio_buffer_cleared", true);
      }
    }

    if (event?.type === "response.done" && this.atomicGreetingActiveV35) {
      const id = responseId(event);
      if (id && id === this.atomicGreetingResponseIdV35 && event.response?.status === "failed") {
        this.finishAtomicGreetingV35("response_failed", true);
      }
    }

    if (event?.type === "input_audio_buffer.speech_started") {
      (this as any).diagnostics?.checkpoint?.("CALLER_SPEECH_DURING_ATOMIC_GREETING_V35", {
        atomic_greeting_active: this.atomicGreetingActiveV35,
        awaiting_vad_off: this.atomicGreetingAwaitingVadOffV35,
        response_id: this.atomicGreetingResponseIdV35,
      });
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
