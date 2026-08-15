import { CallSession as CallSessionV34 } from "./call-session-v34";
import {
  ProtectedSpeechLifecycle,
  type ProtectedSpeechKind,
  type ProtectedSpeechRelease,
} from "./protected-speech-lifecycle";

const BaseConstructor = CallSessionV34 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV34.prototype as any;

const INPUT_IGNORED = "restaurant_input_ignored";
const RECOVERY_WINDOW_MS = 10_000;
const RECOVERY_THRESHOLD = 2;
const PROTECTED_SPEECH_WATCHDOG_MS = 30_000;
const PROTECTED_METADATA_KEY = "protected_speech_v35";
const RECOVERY_MESSAGE = "Estoy teniendo dificultad para distinguir si me estás hablando a mí debido al ruido o a otras voces de fondo. Continuamos, ¿en qué puedo ayudarte?";

type RealtimeEvent = {
  type?: string;
  event_id?: string;
  name?: string;
  arguments?: string;
  response_id?: string;
  response?: {
    id?: string;
    status?: string;
    metadata?: Record<string, unknown> | null;
  };
  error?: {
    event_id?: string;
    type?: string;
    code?: string;
    message?: string;
  };
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function parseEvent(data: unknown): RealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEvent; } catch { return null; }
}

function ignoredReason(event: RealtimeEvent): string {
  try {
    const args = event.arguments?.trim() ? JSON.parse(event.arguments) as Record<string, unknown> : {};
    return typeof args.reason === "string" ? args.reason : "UNCERTAIN";
  } catch {
    return "UNCERTAIN";
  }
}

function realtimeResponseId(event: RealtimeEvent): string | null {
  return event.response_id ?? event.response?.id ?? null;
}

function protectedKindFromMetadata(event: RealtimeEvent): ProtectedSpeechKind | null {
  const value = event.response?.metadata?.[PROTECTED_METADATA_KEY];
  return value === "GREETING" || value === "RECOVERY" ? value : null;
}

/**
 * v35 makes only explicitly critical speech atomic.
 *
 * Protected speech lifecycle:
 *   interrupt_response=false
 *   -> response.create tagged with protected metadata
 *   -> correlate response.created/response_id
 *   -> keep protection while SIP output is buffered
 *   -> output_audio_buffer.stopped/cleared (or objective failure path)
 *   -> interrupt_response=true
 *
 * Normal Lucia responses remain interruptible. VAD still observes caller audio;
 * this layer does not interpret semantic intent and does not replace v29 tools.
 */
export class CallSession extends BaseConstructor {
  private protectedSpeechLifecycleV35 = new ProtectedSpeechLifecycle();
  private protectedSpeechWatchdogV35: ReturnType<typeof setTimeout> | null = null;
  private ignoredEventsV35: number[] = [];

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok) {
      (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_POLICY_V35_ENABLED", {
        greeting_uninterruptible: true,
        recovery_uninterruptible: true,
        completion_event: "output_audio_buffer.stopped",
        response_scoped: true,
        failure_release: true,
        recovery_threshold: RECOVERY_THRESHOLD,
        recovery_window_ms: RECOVERY_WINDOW_MS,
      });
    }
    return response;
  }

  /**
   * v2 calls this through `this`, so the v35 instance can make the greeting
   * explicitly protected instead of guessing that the first response.create is
   * necessarily the greeting.
   */
  private sendInitialGreetingIfNeeded(): void {
    const session = this as any;
    if (session.greetingSent || !session.socket || !session.initialGreeting || !session.callId) return;

    const started = this.startProtectedSpeechV35(
      "GREETING",
      `Pronuncia exactamente este saludo inicial y nada más: ${JSON.stringify(session.initialGreeting)}`,
    );
    if (!started) return;

    session.greetingSent = true;
    session.diagnostics?.checkpoint?.("GREETING_SENT", { protected_speech: true });
    session.diagnostics?.checkpoint?.("PROTECTED_GREETING_STARTED_V35", { interrupt_response: false });
  }

  private setInterruptResponseV35(enabled: boolean, reason: string): void {
    (this as any).send?.({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              interrupt_response: enabled,
            },
          },
        },
      },
    });
    (this as any).diagnostics?.checkpoint?.("INTERRUPT_RESPONSE_CHANGED_V35", {
      interrupt_response: enabled,
      reason,
    });
  }

  private startProtectedSpeechV35(kind: ProtectedSpeechKind, instructions: string): boolean {
    if (this.protectedSpeechLifecycleV35.isActive()) return false;
    if ((this as any).state === "closing" || (this as any).hangupStarted) return false;

    const clientEventId = `protected_speech_v35_${crypto.randomUUID()}`;
    if (!this.protectedSpeechLifecycleV35.begin(kind, clientEventId)) return false;

    try {
      this.setInterruptResponseV35(false, `${kind.toLowerCase()}_start`);
      (this as any).send?.({
        event_id: clientEventId,
        type: "response.create",
        response: {
          tool_choice: "none",
          instructions,
          metadata: { [PROTECTED_METADATA_KEY]: kind },
        },
      });
      this.armProtectedSpeechWatchdogV35();
      (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_STARTED_V35", {
        kind,
        interrupt_response: false,
        response_scoped: true,
      });
      return true;
    } catch (error) {
      const release = this.protectedSpeechLifecycleV35.forceRelease("response_create_send_failed");
      this.completeProtectedSpeechReleaseV35(release);
      (this as any).diagnostics?.fail?.("PROTECTED_SPEECH_START_FAILED_V35", "PROTECTED_SPEECH_SEND_FAILED", {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private armProtectedSpeechWatchdogV35(): void {
    this.clearProtectedSpeechWatchdogV35();
    this.protectedSpeechWatchdogV35 = setTimeout(() => {
      const release = this.protectedSpeechLifecycleV35.forceRelease("protected_speech_watchdog");
      if (!release.released) return;
      (this as any).diagnostics?.fail?.("PROTECTED_SPEECH_WATCHDOG_V35", "PROTECTED_SPEECH_TERMINAL_EVENT_MISSING", {
        kind: release.kind ?? null,
        watchdog_ms: PROTECTED_SPEECH_WATCHDOG_MS,
      });
      this.completeProtectedSpeechReleaseV35(release);
    }, PROTECTED_SPEECH_WATCHDOG_MS);
  }

  private clearProtectedSpeechWatchdogV35(): void {
    if (!this.protectedSpeechWatchdogV35) return;
    clearTimeout(this.protectedSpeechWatchdogV35);
    this.protectedSpeechWatchdogV35 = null;
  }

  private completeProtectedSpeechReleaseV35(release: ProtectedSpeechRelease): void {
    if (!release.released) return;
    this.clearProtectedSpeechWatchdogV35();
    this.setInterruptResponseV35(true, release.reason ?? "protected_speech_complete");
    (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_COMPLETED_V35", {
      kind: release.kind ?? null,
      reason: release.reason ?? null,
      interrupt_response: true,
    });
  }

  private startProtectedRecoveryV35(): void {
    const started = this.startProtectedSpeechV35(
      "RECOVERY",
      `Pronuncia exactamente esta frase completa y nada más: ${JSON.stringify(RECOVERY_MESSAGE)}`,
    );
    if (!started) return;
    (this as any).diagnostics?.checkpoint?.("PROTECTED_RECOVERY_STARTED_V35", {
      interrupt_response: false,
      message: RECOVERY_MESSAGE,
    });
  }

  private noteIgnoredInputV35(reason: string): void {
    const now = Date.now();
    this.ignoredEventsV35 = this.ignoredEventsV35.filter((timestamp) => now - timestamp <= RECOVERY_WINDOW_MS);
    this.ignoredEventsV35.push(now);
    (this as any).diagnostics?.checkpoint?.("IGNORED_INPUT_COUNTED_V35", {
      reason,
      count_in_window: this.ignoredEventsV35.length,
      recovery_threshold: RECOVERY_THRESHOLD,
    });
    if (this.ignoredEventsV35.length >= RECOVERY_THRESHOLD) {
      this.ignoredEventsV35 = [];
      this.startProtectedRecoveryV35();
    }
  }

  private correlateProtectedResponseV35(event: RealtimeEvent): void {
    const snapshot = this.protectedSpeechLifecycleV35.snapshot();
    if (!snapshot || snapshot.responseId) return;
    const responseId = realtimeResponseId(event);
    if (!responseId) return;

    const metadataKind = protectedKindFromMetadata(event);
    if (metadataKind && metadataKind !== snapshot.kind) return;

    if (this.protectedSpeechLifecycleV35.bindResponse(responseId)) {
      (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_RESPONSE_BOUND_V35", {
        kind: snapshot.kind,
        response_id: responseId,
        metadata_confirmed: metadataKind === snapshot.kind,
      });
    }
  }

  private handleProtectedLifecycleEventV35(event: RealtimeEvent): void {
    if (!this.protectedSpeechLifecycleV35.isActive()) return;
    const responseId = realtimeResponseId(event);

    if (event.type === "response.created") {
      this.correlateProtectedResponseV35(event);
      return;
    }

    if (event.type === "output_audio_buffer.started") {
      if (this.protectedSpeechLifecycleV35.markPlaybackStarted(responseId)) {
        (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_PLAYBACK_STARTED_V35", { response_id: responseId });
      }
      return;
    }

    if (event.type === "output_audio_buffer.stopped") {
      this.completeProtectedSpeechReleaseV35(this.protectedSpeechLifecycleV35.onPlaybackStopped(responseId));
      return;
    }

    if (event.type === "output_audio_buffer.cleared") {
      this.completeProtectedSpeechReleaseV35(this.protectedSpeechLifecycleV35.onPlaybackCleared(responseId));
      return;
    }

    if (event.type === "response.done") {
      this.completeProtectedSpeechReleaseV35(
        this.protectedSpeechLifecycleV35.onResponseDone(responseId, event.response?.status),
      );
      return;
    }

    if (event.type === "error") {
      this.completeProtectedSpeechReleaseV35(
        this.protectedSpeechLifecycleV35.onClientError(event.error?.event_id),
      );
    }
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "response.function_call_arguments.done" && event.name === INPUT_IGNORED) {
      const reason = ignoredReason(event);
      await BasePrototype.handleRealtimeMessage.call(this, data);
      this.noteIgnoredInputV35(reason);
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
    if (event) this.handleProtectedLifecycleEventV35(event);
  }
}
