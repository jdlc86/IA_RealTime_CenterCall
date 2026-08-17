import { CallSession as CallSessionV39 } from "./call-session-v39";
import { CallSession as CallSessionV37 } from "./call-session-v37";
import {
  ConversationTurnLifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
} from "./conversation-turn-lifecycle";
import { adaptRealtimeTurnEvent, type SyntheticRealtimeEvent } from "./realtime-turn-lifecycle-adapter";
import type { ProtectedSpeechSnapshot } from "./protected-speech-lifecycle";

const BaseConstructor = CallSessionV39 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV39.prototype as any;
const HandoffPrototype = CallSessionV37.prototype as any;

const FIRST_PRESENCE_CHECK_MS = 8_000;
const SILENCE_CLOSE_MS = 26_000;
const PROCESSING_GUARD_MS = 12_000;
const MAX_CALL_DURATION_MS = 15 * 60_000;
const PRESENCE_METADATA_PURPOSE = "presence_check_v40";
const RECOVERY_MESSAGE = "No he podido seguir bien lo que me indicas. ¿Puedes decirme de nuevo en qué puedo ayudarte?";
const SILENCE_FAREWELL = "Parece que ya no estás disponible. Gracias por llamar. Hasta luego.";
const IGNORED_FAREWELL = "No he podido mantener una conversación clara. Gracias por llamar. Hasta luego.";
const COST_FAREWELL = "Necesito finalizar esta llamada. Gracias por contactar con nosotros. Hasta luego.";

type RealtimeEventV40 = SyntheticRealtimeEvent & {
  response_id?: string;
  response?: {
    id?: string;
    status?: string;
    metadata?: Record<string, unknown> | null;
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

function parseRealtimeEvent(data: unknown): RealtimeEventV40 | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEventV40; } catch { return null; }
}

function responseId(event: RealtimeEventV40 | null): string | null {
  return event?.response_id ?? event?.response?.id ?? null;
}

export class CallSession extends BaseConstructor {
  private conversationLifecycleV40 = new ConversationTurnLifecycle();
  private presenceTimerV40: ReturnType<typeof setTimeout> | null = null;
  private silenceCloseTimerV40: ReturnType<typeof setTimeout> | null = null;
  private processingGuardTimerV40: ReturnType<typeof setTimeout> | null = null;
  private maxCallTimerV40: ReturnType<typeof setTimeout> | null = null;
  private activeSilenceEpochV40: number | null = null;
  private presenceResponseIdV40: string | null = null;
  private terminalReasonV40 = "conversation_turn_lifecycle_v40";
  private lifecycleInstalledV40 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok && !this.lifecycleInstalledV40) {
      this.lifecycleInstalledV40 = true;
      this.armMaxCallDurationV40();
      (this as any).diagnostics?.checkpoint?.("CONVERSATION_TURN_LIFECYCLE_V40_ENABLED", {
        first_presence_check_ms: FIRST_PRESENCE_CHECK_MS,
        silence_close_ms: SILENCE_CLOSE_MS,
        processing_guard_ms: PROCESSING_GUARD_MS,
        max_call_duration_ms: MAX_CALL_DURATION_MS,
        legacy_v18_relative_watchdog: "disabled_by_v40_hooks",
        semantic_classifier_added: false,
      });
    }
    return response;
  }

  private armMaxCallDurationV18(): void { }
  private armWaitingForUserV18(_trigger: string): void { }
  private scheduleNextInactivityCheckV18(): void { }
  private validateUserTurnV18(_source: string): void { }
  private suspendForToolV18(_tool: string): void { }
  private issuePresenceRecoveryV18(_phrase: string): void { }
  private noteIgnoredInputV35(_reason: string): void { }

  private async beginHumanHandoffV37(event: unknown): Promise<boolean> {
    const accepted = await HandoffPrototype.beginHumanHandoffV37.call(this, event);
    if (accepted) {
      this.clearProcessingGuardV40();
      this.dispatchLifecycleV40({ type: "handoff_started" });
    }
    return accepted;
  }

  private clearSilenceTimersV40(): void {
    if (this.presenceTimerV40 !== null) clearTimeout(this.presenceTimerV40);
    if (this.silenceCloseTimerV40 !== null) clearTimeout(this.silenceCloseTimerV40);
    this.presenceTimerV40 = null;
    this.silenceCloseTimerV40 = null;
    this.activeSilenceEpochV40 = null;
  }

  private clearProcessingGuardV40(): void {
    if (this.processingGuardTimerV40 !== null) clearTimeout(this.processingGuardTimerV40);
    this.processingGuardTimerV40 = null;
  }

  private clearMaxCallTimerV40(): void {
    if (this.maxCallTimerV40 !== null) clearTimeout(this.maxCallTimerV40);
    this.maxCallTimerV40 = null;
  }

  private armSilenceTimersV40(epoch: number): void {
    this.clearSilenceTimersV40();
    this.activeSilenceEpochV40 = epoch;
    this.presenceTimerV40 = setTimeout(() => {
      this.presenceTimerV40 = null;
      this.dispatchLifecycleV40({ type: "presence_deadline", epoch });
    }, FIRST_PRESENCE_CHECK_MS);
    this.silenceCloseTimerV40 = setTimeout(() => {
      this.silenceCloseTimerV40 = null;
      this.dispatchLifecycleV40({ type: "silence_close_deadline", epoch });
    }, SILENCE_CLOSE_MS);
  }

  private armProcessingGuardV40(): void {
    this.clearProcessingGuardV40();
    this.processingGuardTimerV40 = setTimeout(() => {
      this.processingGuardTimerV40 = null;
      (this as any).releaseTurnConcurrencyForRecoveryV36?.("v40_processing_guard_expired");
      this.dispatchLifecycleV40({ type: "processing_guard_expired" });
    }, PROCESSING_GUARD_MS);
  }

  private armMaxCallDurationV40(): void {
    this.clearMaxCallTimerV40();
    this.maxCallTimerV40 = setTimeout(() => {
      this.maxCallTimerV40 = null;
      this.dispatchLifecycleV40({ type: "max_call_duration" });
    }, MAX_CALL_DURATION_MS);
  }

  private dispatchLifecycleV40(event: LifecycleEvent): void {
    const effects = this.conversationLifecycleV40.dispatch(event);
    if (event.type === "semantic_valid" || event.type === "semantic_ignored" || event.type === "out_of_scope" || event.type === "end_call" || event.type === "handoff_started") {
      this.clearProcessingGuardV40();
    }
    this.applyLifecycleEffectsV40(effects);
    (this as any).diagnostics?.checkpoint?.("CONVERSATION_TURN_STATE_V40", {
      event: event.type,
      state: this.conversationLifecycleV40.snapshot().state,
      ignored_count: this.conversationLifecycleV40.snapshot().ignoredCount,
      silence_epoch: this.conversationLifecycleV40.snapshot().silenceEpoch,
      silence_timer_armed: this.conversationLifecycleV40.snapshot().silenceTimerArmed,
    });
  }

  private applyLifecycleEffectsV40(effects: LifecycleEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case "ARM_SILENCE_TIMER":
          this.armSilenceTimersV40(effect.epoch);
          break;
        case "CANCEL_SILENCE_TIMER":
          if (this.activeSilenceEpochV40 === null || this.activeSilenceEpochV40 === effect.epoch) this.clearSilenceTimersV40();
          break;
        case "SPEAK_PRESENCE_CHECK":
          this.speakPresenceCheckV40();
          break;
        case "SPEAK_IGNORED_RECOVERY":
          this.speakProtectedRecoveryV40();
          break;
        case "SPEAK_TERMINAL_FAREWELL":
          this.speakProtectedTerminalV40(effect.reason);
          break;
        case "SUSPEND_FOR_HANDOFF":
          this.clearSilenceTimersV40();
          this.clearProcessingGuardV40();
          this.clearMaxCallTimerV40();
          break;
        case "HANGUP":
          this.clearSilenceTimersV40();
          this.clearProcessingGuardV40();
          this.clearMaxCallTimerV40();
          (this as any).state = "closing";
          (this as any).closingReason = this.terminalReasonV40;
          void (this as any).performHangup?.("conversation_turn_lifecycle_v40");
          break;
        case "IGNORED_COUNT_CHANGED":
        case "RESET_IGNORED_COUNT":
          break;
      }
    }
  }

  private speakPresenceCheckV40(): void {
    if (!(this as any).socket || (this as any).state === "closing" || (this as any).hangupStarted) return;
    this.presenceResponseIdV40 = null;
    (this as any).send?.({
      type: "response.create",
      response: {
        conversation: "none",
        tool_choice: "none",
        metadata: { purpose: PRESENCE_METADATA_PURPOSE },
        instructions: "Pronuncia exactamente esta frase y nada más: ¿Sigues ahí?",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Pronuncia exactamente: ¿Sigues ahí?" }] }],
      },
    });
    (this as any).diagnostics?.checkpoint?.("USER_PRESENCE_CHECK_V40_REQUESTED", {
      resets_silence_episode: false,
      barge_in_allowed: true,
    });
  }

  private speakProtectedRecoveryV40(): void {
    const started = (this as any).startProtectedSpeechV35?.(
      "RECOVERY",
      `Pronuncia exactamente esta frase completa y nada más: ${JSON.stringify(RECOVERY_MESSAGE)}`,
    ) === true;
    if (!started) {
      (this as any).diagnostics?.fail?.("PROTECTED_RECOVERY_V40_START_FAILED", "PROTECTED_SPEECH_BUSY_OR_UNAVAILABLE", {});
    }
  }

  private speakProtectedTerminalV40(reason: string): void {
    this.clearSilenceTimersV40();
    this.clearProcessingGuardV40();
    this.terminalReasonV40 = reason;
    const phrase = reason === "silence_timeout"
      ? SILENCE_FAREWELL
      : reason === "max_call_duration"
        ? COST_FAREWELL
        : IGNORED_FAREWELL;
    const started = (this as any).startProtectedSpeechV35?.(
      "TERMINAL",
      `Pronuncia exactamente esta frase completa y nada más: ${JSON.stringify(phrase)}`,
    ) === true;
    if (!started) {
      (this as any).diagnostics?.fail?.("PROTECTED_TERMINAL_V40_START_FAILED", "PROTECTED_SPEECH_BUSY_OR_UNAVAILABLE", { reason });
      (this as any).beginClosing?.(reason, "conversation_turn_lifecycle_v40_fallback");
    }
  }

  private protectedSnapshotV40(): ProtectedSpeechSnapshot | null {
    return (this as any).protectedSpeechLifecycleV35?.snapshot?.() ?? null;
  }

  private outputKindV40(event: RealtimeEventV40, protectedBefore: ProtectedSpeechSnapshot | null): "NORMAL" | "GREETING" | "RECOVERY" | "TERMINAL" | "PRESENCE" {
    const id = responseId(event);
    if (id && this.presenceResponseIdV40 && id === this.presenceResponseIdV40) return "PRESENCE";
    if (id && protectedBefore?.responseId === id) return protectedBefore.kind;
    return "NORMAL";
  }

  private dispatchAdaptedV40(event: RealtimeEventV40): void {
    if (event.type === "response.function_call_arguments.done" && event.name === "restaurant_end_call") return;
    for (const adapted of adaptRealtimeTurnEvent(event)) this.dispatchLifecycleV40(adapted);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseRealtimeEvent(data);
    const protectedBefore = this.protectedSnapshotV40();

    if (event?.type === "input_audio_buffer.speech_started" || event?.type === "input_audio_buffer.speech_stopped" || event?.type === "conversation.item.input_audio_transcription.completed") {
      this.dispatchAdaptedV40(event);
      if (event.type === "input_audio_buffer.speech_stopped") this.armProcessingGuardV40();
      if (event.type === "conversation.item.input_audio_transcription.completed" && !(typeof event.transcript === "string" && event.transcript.trim())) {
        this.clearProcessingGuardV40();
      }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name !== "restaurant_input_ignored" && event.name !== "restaurant_end_call") {
      this.clearProcessingGuardV40();
      this.dispatchAdaptedV40(event);
    }

    if (event?.type === "output_audio_buffer.started") {
      const kind = this.outputKindV40(event, protectedBefore);
      this.clearProcessingGuardV40();
      if (kind !== "PRESENCE") this.dispatchLifecycleV40({ type: "assistant_audio_started", kind });
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (event?.type === "response.created" && event.response?.metadata?.purpose === PRESENCE_METADATA_PURPOSE) {
      this.presenceResponseIdV40 = responseId(event);
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === "restaurant_input_ignored") {
      this.clearProcessingGuardV40();
      this.dispatchAdaptedV40(event);
    }

    if (event?.type === "output_audio_buffer.stopped") {
      const kind = this.outputKindV40(event, protectedBefore);
      if (kind === "PRESENCE") {
        if (responseId(event) === this.presenceResponseIdV40) this.presenceResponseIdV40 = null;
        (this as any).diagnostics?.checkpoint?.("USER_PRESENCE_CHECK_V40_COMPLETED", {
          silence_episode_preserved: true,
        });
      } else {
        this.dispatchLifecycleV40({ type: "assistant_audio_stopped", kind });
      }
    }
  }
}
