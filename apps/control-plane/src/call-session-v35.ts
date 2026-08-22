import { CallSession as CallSessionV34 } from "./call-session-v34";
import {
  ProtectedSpeechLifecycle,
  type ProtectedSpeechKind,
  type ProtectedSpeechRelease,
} from "./protected-speech-lifecycle";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import { inputDetectionConfigRuntimeFor } from "./input-detection-config-runtime.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { sessionTaskRuntimeFor } from "./session-task-runtime.js";

const BaseConstructor = CallSessionV34 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV34.prototype as any;

const INPUT_IGNORED = "restaurant_input_ignored";
const RECOVERY_WINDOW_MS = 10_000;
const RECOVERY_THRESHOLD = 2;
const PROTECTED_SPEECH_WATCHDOG_MS = 30_000;
const PROTECTED_METADATA_KEY = "protected_speech_v35";
const RECOVERY_MESSAGE = "Estoy teniendo dificultad para distinguir si me estás hablando a mí debido al ruido o a otras voces de fondo. Continuamos, ¿en qué puedo ayudarte?";

function ignoredReason(rawArguments: string | undefined): string {
  try {
    const args = rawArguments?.trim() ? JSON.parse(rawArguments) as Record<string, unknown> : {};
    return typeof args.reason === "string" ? args.reason : "UNCERTAIN";
  } catch {
    return "UNCERTAIN";
  }
}

/**
 * v35 makes only explicitly critical speech atomic.
 *
 * Protected speech is expressed only through provider-neutral command and event
 * boundaries. Normal Lucia responses remain interruptible; recovery and greeting
 * speech temporarily use non-interrupting listening until playback drains or an
 * objective failure path releases the protected lifecycle.
 */
export class CallSession extends BaseConstructor {
  private protectedSpeechLifecycleV35 = new ProtectedSpeechLifecycle();
  private protectedSpeechWatchdogV35: ReturnType<typeof setTimeout> | null = null;
  private protectedSpeechTextV35: string | null = null;
  private ignoredEventsV35: number[] = [];

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok) {
      (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_POLICY_V35_ENABLED", {
        greeting_uninterruptible: true,
        recovery_uninterruptible: true,
        input_detection_suspended: true,
        cleared_playback_replayed: true,
        completion_event: "assistant_audio_stopped",
        response_scoped: true,
        failure_release: true,
        recovery_threshold: RECOVERY_THRESHOLD,
        recovery_window_ms: RECOVERY_WINDOW_MS,
        provider_boundary: "realtime_provider_runtime",
      });
    }
    return response;
  }

  private commandsV35() { return realtimeCommandPortFor(this as any); }

  /**
   * v2 calls this through `this`, so the v35 instance can make the greeting
   * explicitly protected instead of guessing that the first assistant response
   * is necessarily the greeting.
   */
  private sendInitialGreetingIfNeeded(): void {
    const session = this as any;
    if (session.greetingSent || !session.socket || !session.initialGreeting || !session.callId) return;

    const started = this.startProtectedSpeechV35(
      "GREETING",
      session.initialGreeting,
    );
    if (!started) return;

    session.greetingSent = true;
    session.diagnostics?.checkpoint?.("GREETING_SENT", { protected_speech: true });
    session.diagnostics?.checkpoint?.("PROTECTED_GREETING_STARTED_V35", { interrupt_response: false });
  }

  private setInterruptResponseV35(enabled: boolean, reason: string): void {
    const commands = this.commandsV35();
    if (enabled) commands.restoreInputDetection(inputDetectionConfigRuntimeFor(this).get());
    else commands.suspendInputDetection();
    (this as any).diagnostics?.checkpoint?.("INTERRUPT_RESPONSE_CHANGED_V35", {
      interrupt_response: enabled,
      input_detection_suspended: !enabled,
      reason,
      provider_command_port: true,
    });
  }

  private protectedSpeechInstructionsV35(kind: ProtectedSpeechKind, exactText: string): string {
    const label = kind === "GREETING" ? "este saludo inicial" : "esta frase completa";
    return `Pronuncia exactamente ${label} y nada más: ${JSON.stringify(exactText)}`;
  }

  private emitProtectedSpeechAttemptV35(
    kind: ProtectedSpeechKind,
    exactText: string,
    clientEventId: string,
    replayCount: number,
  ): void {
    this.commandsV35().speak({
      requestId: clientEventId,
      isolated: true,
      tools: "DISABLED",
      exactText,
      instructions: this.protectedSpeechInstructionsV35(kind, exactText),
      metadata: { [PROTECTED_METADATA_KEY]: kind },
    });
    this.armProtectedSpeechWatchdogV35();
    (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_ATTEMPT_REQUESTED_V35", {
      kind,
      replay_count: replayCount,
      input_detection_suspended: true,
      exact_text_governed: true,
      provider_command_port: true,
    });
  }

  private startProtectedSpeechV35(kind: ProtectedSpeechKind, exactText: string): boolean {
    if (this.protectedSpeechLifecycleV35.isActive()) return false;
    if (conversationLifecyclePortFor(this).isTerminal()) return false;

    const clientEventId = `protected_speech_v35_${crypto.randomUUID()}`;
    if (!this.protectedSpeechLifecycleV35.begin(kind, clientEventId)) return false;
    this.protectedSpeechTextV35 = exactText;

    try {
      this.setInterruptResponseV35(false, `${kind.toLowerCase()}_start`);
      this.commandsV35().clearInput();
      this.emitProtectedSpeechAttemptV35(kind, exactText, clientEventId, 0);
      (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_STARTED_V35", {
        kind,
        interrupt_response: false,
        input_detection_suspended: true,
        input_buffer_cleared: true,
        response_scoped: true,
        provider_command_port: true,
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
      sessionTaskRuntimeFor(this).enqueue("protected_speech_watchdog_v35", () => {
        const release = this.protectedSpeechLifecycleV35.forceRelease("protected_speech_watchdog");
        if (!release.released) return;
        (this as any).diagnostics?.fail?.("PROTECTED_SPEECH_WATCHDOG_V35", "PROTECTED_SPEECH_TERMINAL_EVENT_MISSING", {
          kind: release.kind ?? null,
          watchdog_ms: PROTECTED_SPEECH_WATCHDOG_MS,
        });
        this.completeProtectedSpeechReleaseV35(release);
      });
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
    this.protectedSpeechTextV35 = null;
    try {
      this.commandsV35().clearInput();
      this.setInterruptResponseV35(true, release.reason ?? "protected_speech_complete");
    } catch (error) {
      (this as any).diagnostics?.fail?.("PROTECTED_SPEECH_INPUT_RESTORE_FAILED_V35", "INPUT_DETECTION_RESTORE_FAILED", {
        kind: release.kind ?? null,
        reason: release.reason ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_COMPLETED_V35", {
      kind: release.kind ?? null,
      reason: release.reason ?? null,
      interrupt_response: true,
      input_buffer_cleared_before_restore: true,
      provider_command_port: true,
    });
  }

  private applyProtectedSpeechTransitionV35(transition: ProtectedSpeechRelease): void {
    if (transition.released) {
      this.completeProtectedSpeechReleaseV35(transition);
      return;
    }
    if (!transition.replayRequested) return;

    const previous = this.protectedSpeechLifecycleV35.snapshot();
    const exactText = this.protectedSpeechTextV35;
    if (!previous || !exactText) {
      this.completeProtectedSpeechReleaseV35(
        this.protectedSpeechLifecycleV35.forceRelease("protected_speech_replay_state_missing"),
      );
      return;
    }

    const clientEventId = `protected_speech_v35_${crypto.randomUUID()}`;
    if (!this.protectedSpeechLifecycleV35.prepareReplay(clientEventId)) {
      this.completeProtectedSpeechReleaseV35(
        this.protectedSpeechLifecycleV35.forceRelease("protected_speech_replay_prepare_failed"),
      );
      return;
    }

    const replay = this.protectedSpeechLifecycleV35.snapshot();
    try {
      this.clearProtectedSpeechWatchdogV35();
      this.commandsV35().suspendInputDetection();
      this.commandsV35().clearInput();
      this.emitProtectedSpeechAttemptV35(previous.kind, exactText, clientEventId, replay?.replayCount ?? 0);
      (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_REPLAYED_AFTER_CLEAR_V35", {
        kind: previous.kind,
        previous_response_id: previous.responseId,
        replay_count: replay?.replayCount ?? null,
        input_detection_suspended: true,
        input_buffer_cleared: true,
        timing_heuristic: false,
      });
    } catch (error) {
      const release = this.protectedSpeechLifecycleV35.forceRelease("protected_speech_replay_send_failed");
      this.completeProtectedSpeechReleaseV35(release);
      (this as any).diagnostics?.fail?.("PROTECTED_SPEECH_REPLAY_FAILED_V35", "PROTECTED_SPEECH_REPLAY_SEND_FAILED", {
        kind: previous.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private startProtectedRecoveryV35(): void {
    const started = this.startProtectedSpeechV35(
      "RECOVERY",
      RECOVERY_MESSAGE,
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

  private correlateProtectedResponseV35(event: Extract<RealtimeProviderEvent, { type: "ASSISTANT_RESPONSE_STARTED" }>): void {
    const snapshot = this.protectedSpeechLifecycleV35.snapshot();
    if (!snapshot || snapshot.responseId || event.kind !== snapshot.kind || !event.responseId) return;

    if (this.protectedSpeechLifecycleV35.bindResponse(event.responseId)) {
      (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_RESPONSE_BOUND_V35", {
        kind: snapshot.kind,
        response_id: event.responseId,
        metadata_confirmed: true,
        provider_event_adapter: true,
      });
    }
  }

  private handleProtectedLifecycleEventV35(event: RealtimeProviderEvent): void {
    if (!this.protectedSpeechLifecycleV35.isActive()) return;

    if (event.type === "ASSISTANT_RESPONSE_STARTED") {
      this.correlateProtectedResponseV35(event);
      return;
    }

    if (event.type === "ASSISTANT_AUDIO_STARTED") {
      if (this.protectedSpeechLifecycleV35.markPlaybackStarted(event.responseId)) {
        (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_PLAYBACK_STARTED_V35", { response_id: event.responseId ?? null });
      }
      return;
    }

    if (event.type === "ASSISTANT_AUDIO_STOPPED") {
      this.completeProtectedSpeechReleaseV35(this.protectedSpeechLifecycleV35.onPlaybackStopped(event.responseId));
      return;
    }

    if (event.type === "ASSISTANT_AUDIO_CLEARED") {
      const transition = this.protectedSpeechLifecycleV35.onPlaybackCleared(event.responseId);
      (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_PLAYBACK_CLEARED_V35", {
        response_id: event.responseId ?? null,
        protection_released: transition.released,
        replay_requested: transition.replayRequested ?? false,
      });
      this.applyProtectedSpeechTransitionV35(transition);
      return;
    }

    if (event.type === "ASSISTANT_RESPONSE_COMPLETED") {
      this.applyProtectedSpeechTransitionV35(
        this.protectedSpeechLifecycleV35.onResponseDone(event.responseId, event.status),
      );
      return;
    }

    if (event.type === "PROVIDER_COMMAND_FAILED") {
      this.completeProtectedSpeechReleaseV35(
        this.protectedSpeechLifecycleV35.onClientError(event.requestId),
      );
    }
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const events = adaptRealtimeProviderEvents(data);
    await BasePrototype.handleRealtimeMessage.call(this, data);

    for (const event of events) {
      this.handleProtectedLifecycleEventV35(event);
      if (event.type === "SEMANTIC_TOOL_SELECTED" && event.name === INPUT_IGNORED) {
        this.noteIgnoredInputV35(ignoredReason(event.arguments));
      }
    }
  }
}
