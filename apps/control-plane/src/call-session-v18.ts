import { CallSession as CallSessionV17 } from "./call-session-v17";
import { ConversationTurnLifecycle, type LifecycleEffect, type LifecycleEvent } from "./conversation-turn-lifecycle";
import { adaptRealtimeTurnEvent } from "./realtime-turn-lifecycle-adapter";
import { adaptOpenAIRealtimeEvent } from "./openai-realtime-event-adapter";
import { realtimeCommandPortFor } from "./openai-realtime-command-adapter";

const BaseConstructor = CallSessionV17 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV17.prototype as any;

const FIRST_PRESENCE_CHECK_MS = 8_000;
const MAX_UNANSWERED_WAIT_MS = 26_000;
const MAX_CALL_DURATION_MS = 15 * 60_000;

export class CallSession extends BaseConstructor {
  private turnLifecycleV18 = new ConversationTurnLifecycle();
  private presenceTimerV18: ReturnType<typeof setTimeout> | null = null;
  private silenceCloseTimerV18: ReturnType<typeof setTimeout> | null = null;
  private maxCallTimerV18: ReturnType<typeof setTimeout> | null = null;
  private presenceResponseIdV18: string | null = null;
  private presenceRequestPendingV18 = false;
  private lifecycleInstalledV18 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok && !this.lifecycleInstalledV18) {
      this.lifecycleInstalledV18 = true;
      this.armMaxCallDurationV18();
      (this as any).diagnostics?.checkpoint?.("CONVERSATION_TURN_LIFECYCLE_V18_ENABLED", {
        authority: "ConversationTurnLifecycle", presence_check_ms: FIRST_PRESENCE_CHECK_MS,
        silence_close_ms: MAX_UNANSWERED_WAIT_MS, max_call_duration_ms: MAX_CALL_DURATION_MS,
        epoch_scoped_deadlines: true, legacy_presence_stages_removed: true, provider_command_port: true,
        provider_event_adapter: true,
      });
    }
    return response;
  }

  protected snapshotTurnLifecycleV18(): ReturnType<ConversationTurnLifecycle["snapshot"]> { return this.turnLifecycleV18.snapshot(); }
  protected observeSemanticIgnoredV18(reason: string): void { this.dispatchLifecycleV18({ type: "semantic_ignored", reason }); }
  protected observeHumanHandoffStartedV18(): void { this.dispatchLifecycleV18({ type: "handoff_started" }); }
  protected observeRealtimeTransportClosedV18(reason: string): void {
    this.dispatchLifecycleV18({ type: "transport_closed", reason });
  }

  private clearPresenceTimersV18(): void {
    if (this.presenceTimerV18 !== null) clearTimeout(this.presenceTimerV18);
    if (this.silenceCloseTimerV18 !== null) clearTimeout(this.silenceCloseTimerV18);
    this.presenceTimerV18 = null;
    this.silenceCloseTimerV18 = null;
  }
  private clearMaxCallTimerV18(): void {
    if (this.maxCallTimerV18 !== null) clearTimeout(this.maxCallTimerV18);
    this.maxCallTimerV18 = null;
  }
  private resetPresenceResponseStateV18(): void {
    this.presenceRequestPendingV18 = false;
    this.presenceResponseIdV18 = null;
  }
  private armSilenceEpochV18(epoch: number): void {
    this.clearPresenceTimersV18();
    this.presenceTimerV18 = setTimeout(() => { this.presenceTimerV18 = null; this.dispatchLifecycleV18({ type: "presence_deadline", epoch }); }, FIRST_PRESENCE_CHECK_MS);
    this.silenceCloseTimerV18 = setTimeout(() => { this.silenceCloseTimerV18 = null; this.dispatchLifecycleV18({ type: "silence_close_deadline", epoch }); }, MAX_UNANSWERED_WAIT_MS);
    (this as any).diagnostics?.checkpoint?.("LIFECYCLE_SILENCE_EPOCH_ARMED_V18", { epoch, presence_check_ms: FIRST_PRESENCE_CHECK_MS, silence_close_ms: MAX_UNANSWERED_WAIT_MS });
  }
  private armMaxCallDurationV18(): void {
    this.clearMaxCallTimerV18();
    this.maxCallTimerV18 = setTimeout(() => { this.maxCallTimerV18 = null; this.dispatchLifecycleV18({ type: "max_call_duration" }); }, MAX_CALL_DURATION_MS);
  }
  private commandsV18() { return realtimeCommandPortFor(this as any); }

  private issuePresenceCheckV18(): void {
    if (!(this as any).socket || (this as any).state === "closing" || (this as any).hangupStarted) return;
    this.presenceRequestPendingV18 = true;
    this.presenceResponseIdV18 = null;
    (this as any).diagnostics?.checkpoint?.("USER_PRESENCE_RECOVERY_REQUESTED", {
      lifecycle_state: this.turnLifecycleV18.snapshot().state, conversation: "none",
      isolated_from_agent_context: true, lifecycle_authority: true, provider_command_port: true,
    });
    this.commandsV18().speak({
      purpose: "presence_recovery_v18", isolated: true, tools: "DISABLED",
      instructions: "Pronuncia exactamente esta frase y nada más: \"¿Sigues ahí?\". No respondas al historial y no llames herramientas.",
      exactText: "Pronuncia exactamente: ¿Sigues ahí?",
    });
  }

  private executeLifecycleEffectV18(effect: LifecycleEffect): void {
    switch (effect.type) {
      case "ARM_SILENCE_TIMER": this.armSilenceEpochV18(effect.epoch); break;
      case "CANCEL_SILENCE_TIMER": this.clearPresenceTimersV18(); break;
      case "CANCEL_MAX_CALL_TIMER": this.clearMaxCallTimerV18(); break;
      case "RESET_PRESENCE_RESPONSE_STATE": this.resetPresenceResponseStateV18(); break;
      case "SPEAK_PRESENCE_CHECK": this.issuePresenceCheckV18(); break;
      case "SPEAK_IGNORED_RECOVERY":
        this.commandsV18().speak({
          isolated: true, tools: "DISABLED", metadata: { protected_speech_v35: "RECOVERY" },
          instructions: "Di brevemente: \"Perdona, no te he entendido. ¿Puedes repetirlo?\"",
        });
        break;
      case "SPEAK_TERMINAL_FAREWELL":
        this.clearPresenceTimersV18();
        (this as any).diagnostics?.checkpoint?.("LIFECYCLE_TERMINAL_REQUESTED_V18", { reason: effect.reason });
        (this as any).beginClosing?.(effect.reason, "conversation_turn_lifecycle");
        break;
      case "HANGUP":
        this.clearPresenceTimersV18();
        (this as any).diagnostics?.checkpoint?.("LIFECYCLE_HANGUP_DISPATCHED_V18", {
          authority: "ConversationTurnLifecycle",
          transport_executor: "performHangup",
          trigger: "lifecycle_terminal_audio_stopped",
        });
        void (this as any).performHangup?.("lifecycle_terminal_audio_stopped");
        break;
      case "RESET_IGNORED_COUNT":
      case "IGNORED_COUNT_CHANGED":
      case "SUSPEND_FOR_HANDOFF":
        (this as any).diagnostics?.checkpoint?.("CONVERSATION_LIFECYCLE_EFFECT_V18", { effect: effect.type, ...effect });
        break;
    }
  }

  private dispatchLifecycleV18(event: LifecycleEvent): void {
    const before = this.turnLifecycleV18.snapshot();
    const effects = this.turnLifecycleV18.dispatch(event);
    const after = this.turnLifecycleV18.snapshot();
    (this as any).diagnostics?.checkpoint?.("CONVERSATION_TURN_LIFECYCLE_TRANSITION_V18", {
      event: event.type, before: before.state, after: after.state, silence_epoch: after.silenceEpoch,
      effects: effects.map((effect) => effect.type),
    });
    for (const effect of effects) this.executeLifecycleEffectV18(effect);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptOpenAIRealtimeEvent(data);
    for (const providerEvent of providerEvents) {
      if (providerEvent.type === "ASSISTANT_RESPONSE_STARTED" && this.presenceRequestPendingV18 && !this.presenceResponseIdV18 && providerEvent.purpose === "presence_recovery_v18") {
        this.presenceResponseIdV18 = providerEvent.responseId ?? null;
      }

      const adapted = adaptRealtimeTurnEvent(providerEvent);
      for (const lifecycleEvent of adapted) {
        const isPresenceAudio =
          (providerEvent.type === "ASSISTANT_AUDIO_STARTED" || providerEvent.type === "ASSISTANT_AUDIO_STOPPED") &&
          Boolean(this.presenceResponseIdV18) && providerEvent.responseId === this.presenceResponseIdV18;
        if (isPresenceAudio && (lifecycleEvent.type === "assistant_audio_started" || lifecycleEvent.type === "assistant_audio_stopped")) {
          this.dispatchLifecycleV18({ type: lifecycleEvent.type, kind: "PRESENCE" });
        } else {
          this.dispatchLifecycleV18(lifecycleEvent);
        }
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);

    for (const providerEvent of providerEvents) {
      if (providerEvent.type === "ASSISTANT_AUDIO_STOPPED" && this.presenceResponseIdV18 && providerEvent.responseId === this.presenceResponseIdV18) {
        this.resetPresenceResponseStateV18();
      }
    }
  }
}
