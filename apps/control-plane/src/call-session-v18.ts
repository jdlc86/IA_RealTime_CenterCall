import { CallSession as CallSessionV17 } from "./call-session-v17";
import { ConversationTurnLifecycle, type LifecycleEffect, type LifecycleEvent } from "./conversation-turn-lifecycle";
import { adaptRealtimeTurnEvent } from "./realtime-turn-lifecycle-adapter";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import type { AssistantSpeechKind, RealtimeProviderEvent } from "./realtime-provider-event";
import { sessionTaskRuntimeFor } from "./session-task-runtime.js";

const BaseConstructor = CallSessionV17 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV17.prototype as any;

const FIRST_PRESENCE_CHECK_MS = 20_000;
const MAX_UNANSWERED_WAIT_MS = 45_000;
const MAX_CALL_DURATION_MS = 15 * 60_000;
const TERMINAL_TRANSPORT_DRAIN_MS = 750;
type LifecycleAssistantSpeechKind = NonNullable<Extract<LifecycleEvent, { type: "assistant_audio_started" }>["kind"]>;

export class CallSession extends BaseConstructor {
  private turnLifecycleV18 = new ConversationTurnLifecycle();
  private presenceTimerV18: ReturnType<typeof setTimeout> | null = null;
  private silenceCloseTimerV18: ReturnType<typeof setTimeout> | null = null;
  private maxCallTimerV18: ReturnType<typeof setTimeout> | null = null;
  private terminalDrainTimerV18: ReturnType<typeof setTimeout> | null = null;
  private presenceResponseIdV18: string | null = null;
  private presenceRequestPendingV18 = false;
  private lifecycleInstalledV18 = false;
  private assistantSpeechKindsByResponseIdV18 = new Map<string, AssistantSpeechKind>();
  private terminalPlaybackPendingV18 = false;
  private terminalPlaybackActiveV18 = false;
  private terminalResponseIdV18: string | null = null;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok && !this.lifecycleInstalledV18) {
      this.lifecycleInstalledV18 = true;
      this.armMaxCallDurationV18();
      (this as any).diagnostics?.checkpoint?.("CONVERSATION_TURN_LIFECYCLE_V18_ENABLED", {
        authority: "ConversationTurnLifecycle", presence_check_ms: FIRST_PRESENCE_CHECK_MS,
        silence_close_ms: MAX_UNANSWERED_WAIT_MS, max_call_duration_ms: MAX_CALL_DURATION_MS,
        terminal_transport_drain_ms: TERMINAL_TRANSPORT_DRAIN_MS,
        epoch_scoped_deadlines: true, legacy_presence_stages_removed: true, provider_command_port: true,
        provider_event_adapter: true,
      });
    }
    return response;
  }

  protected snapshotTurnLifecycleV18(): ReturnType<ConversationTurnLifecycle["snapshot"]> { return this.turnLifecycleV18.snapshot(); }
  protected observeSemanticIgnoredV18(reason: string): void { this.dispatchLifecycleV18({ type: "semantic_ignored", reason }); }
  protected observeEndCallConfirmedV18(reason: string): void {
    (this as any).diagnostics?.checkpoint?.("LIFECYCLE_END_CALL_REQUESTED_V18", { reason, authority: "ConversationTurnLifecycle" });
    this.dispatchLifecycleV18({ type: "end_call" });
  }
  protected observeHumanHandoffStartedV18(): void { this.dispatchLifecycleV18({ type: "handoff_started" }); }
  protected observeRealtimeTransportClosedV18(reason: string): void {
    this.terminalPlaybackPendingV18 = false;
    this.terminalPlaybackActiveV18 = false;
    this.terminalResponseIdV18 = null;
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
  private clearTerminalDrainTimerV18(): void {
    if (this.terminalDrainTimerV18 !== null) clearTimeout(this.terminalDrainTimerV18);
    this.terminalDrainTimerV18 = null;
  }
  private resetPresenceResponseStateV18(): void {
    this.presenceRequestPendingV18 = false;
    this.presenceResponseIdV18 = null;
  }
  private armSilenceEpochV18(epoch: number): void {
    this.clearPresenceTimersV18();
    this.presenceTimerV18 = setTimeout(() => {
      sessionTaskRuntimeFor(this).enqueue("presence_deadline_v18", () => {
        this.presenceTimerV18 = null;
        this.dispatchLifecycleV18({ type: "presence_deadline", epoch });
      });
    }, FIRST_PRESENCE_CHECK_MS);
    this.silenceCloseTimerV18 = setTimeout(() => {
      sessionTaskRuntimeFor(this).enqueue("silence_close_deadline_v18", () => {
        this.silenceCloseTimerV18 = null;
        this.dispatchLifecycleV18({ type: "silence_close_deadline", epoch });
      });
    }, MAX_UNANSWERED_WAIT_MS);
    (this as any).diagnostics?.checkpoint?.("LIFECYCLE_SILENCE_EPOCH_ARMED_V18", { epoch, presence_check_ms: FIRST_PRESENCE_CHECK_MS, silence_close_ms: MAX_UNANSWERED_WAIT_MS });
  }
  private armMaxCallDurationV18(): void {
    this.clearMaxCallTimerV18();
    this.maxCallTimerV18 = setTimeout(() => {
      sessionTaskRuntimeFor(this).enqueue("max_call_duration_v18", () => {
        this.maxCallTimerV18 = null;
        this.dispatchLifecycleV18({ type: "max_call_duration" });
      });
    }, MAX_CALL_DURATION_MS);
  }
  private commandsV18() { return realtimeCommandPortFor(this as any); }

  private issuePresenceCheckV18(): void {
    const lifecycleState = this.turnLifecycleV18.snapshot().state;
    if (!(this as any).socket || lifecycleState === "TERMINAL_SPEAKING" || lifecycleState === "HANDOFF" || lifecycleState === "CLOSING") return;
    this.presenceRequestPendingV18 = true;
    this.presenceResponseIdV18 = null;
    (this as any).diagnostics?.checkpoint?.("USER_PRESENCE_RECOVERY_REQUESTED", {
      lifecycle_state: lifecycleState, conversation: "none",
      isolated_from_agent_context: true, lifecycle_authority: true, provider_command_port: true,
    });
    this.commandsV18().speak({
      purpose: "presence_recovery_v18", isolated: true, tools: "DISABLED",
      instructions: "Pronuncia exactamente esta frase y nada más: \"¿Sigues ahí?\". No respondas al historial y no llames herramientas.",
      exactText: "¿Sigues ahí?",
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
        this.clearTerminalDrainTimerV18();
        this.terminalPlaybackPendingV18 = true;
        this.terminalPlaybackActiveV18 = false;
        this.terminalResponseIdV18 = null;
        (this as any).diagnostics?.checkpoint?.("LIFECYCLE_TERMINAL_REQUESTED_V18", {
          reason: effect.reason,
          terminal_playback_tracking: "pending_identity",
          provider_response_id_required: true,
        });
        (this as any).beginClosing?.(effect.reason, "conversation_turn_lifecycle");
        break;
      case "HANGUP":
        this.clearPresenceTimersV18();
        this.terminalPlaybackPendingV18 = false;
        this.terminalPlaybackActiveV18 = false;
        this.terminalResponseIdV18 = null;
        this.clearTerminalDrainTimerV18();
        (this as any).diagnostics?.checkpoint?.("LIFECYCLE_TERMINAL_DRAIN_ARMED_V18", {
          authority: "ConversationTurnLifecycle",
          source_event: "output_audio_buffer.stopped",
          source_guarantee: "openai_server_buffer_drained",
          end_to_end_playout_ack_available: false,
          drain_ms: TERMINAL_TRANSPORT_DRAIN_MS,
          normal_response_latency_affected: false,
        });
        this.terminalDrainTimerV18 = setTimeout(() => {
          sessionTaskRuntimeFor(this).enqueue("terminal_transport_drain_v18", async () => {
            this.terminalDrainTimerV18 = null;
            (this as any).diagnostics?.checkpoint?.("LIFECYCLE_TERMINAL_DRAIN_COMPLETED_V18", {
              authority: "ConversationTurnLifecycle", drain_ms: TERMINAL_TRANSPORT_DRAIN_MS,
            });
            (this as any).diagnostics?.checkpoint?.("LIFECYCLE_HANGUP_DISPATCHED_V18", {
              authority: "ConversationTurnLifecycle", transport_executor: "performHangup",
              trigger: "lifecycle_terminal_transport_drained",
            });
            await (this as any).performHangup?.("lifecycle_terminal_transport_drained");
          });
        }, TERMINAL_TRANSPORT_DRAIN_MS);
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

  private rememberAssistantSpeechKindV18(event: RealtimeProviderEvent): void {
    if (event.type !== "ASSISTANT_RESPONSE_STARTED" || !event.responseId) return;
    this.assistantSpeechKindsByResponseIdV18.set(event.responseId, event.kind);
    if (this.terminalPlaybackPendingV18 && event.kind === "TERMINAL" && !this.terminalResponseIdV18) {
      this.terminalResponseIdV18 = event.responseId;
      (this as any).diagnostics?.checkpoint?.("LIFECYCLE_TERMINAL_RESPONSE_BOUND_V18", {
        response_id: event.responseId,
        authority: "provider_response_identity",
      });
    }
    (this as any).diagnostics?.checkpoint?.("ASSISTANT_SPEECH_KIND_CORRELATED_V18", {
      response_id: event.responseId, kind: event.kind, source: "assistant_response_started",
    });
  }

  private effectiveAssistantSpeechKindV18(event: RealtimeProviderEvent): AssistantSpeechKind | undefined {
    if (event.type !== "ASSISTANT_AUDIO_STARTED" && event.type !== "ASSISTANT_AUDIO_STOPPED" && event.type !== "ASSISTANT_AUDIO_CLEARED") return undefined;
    if (!event.responseId) return event.kind;
    return this.assistantSpeechKindsByResponseIdV18.get(event.responseId) ?? event.kind;
  }

  private lifecycleAssistantSpeechKindV18(event: RealtimeProviderEvent, fallbackKind: LifecycleAssistantSpeechKind | undefined): LifecycleAssistantSpeechKind | undefined {
    const correlatedKind = this.effectiveAssistantSpeechKindV18(event) ?? fallbackKind;
    const lifecycleState = this.turnLifecycleV18.snapshot().state;
    const matchesTerminalIdentity = Boolean(
      event.responseId && this.terminalResponseIdV18 && event.responseId === this.terminalResponseIdV18,
    );

    if (event.type === "ASSISTANT_AUDIO_STARTED" && lifecycleState === "TERMINAL_SPEAKING" && correlatedKind === "TERMINAL" && matchesTerminalIdentity) {
      this.terminalPlaybackPendingV18 = false;
      this.terminalPlaybackActiveV18 = true;
      (this as any).diagnostics?.checkpoint?.("LIFECYCLE_TERMINAL_PLAYBACK_BOUND_V18", {
        response_id: event.responseId,
        provider_kind: event.kind,
        correlated_kind: correlatedKind,
        binding_source: "provider_response_identity",
      });
      return "TERMINAL";
    }

    if (event.type === "ASSISTANT_AUDIO_CLEARED" && lifecycleState === "TERMINAL_SPEAKING" && this.terminalPlaybackActiveV18 && matchesTerminalIdentity) {
      this.terminalPlaybackActiveV18 = false;
      this.terminalPlaybackPendingV18 = true;
      (this as any).diagnostics?.checkpoint?.("LIFECYCLE_TERMINAL_PLAYBACK_CLEARED_V18", {
        response_id: event.responseId,
        provider_kind: event.kind,
        correlated_kind: correlatedKind ?? null,
        authoritative_kind: "TERMINAL",
        terminal_playback_tracking: "rearmed_same_identity",
      });
      return "TERMINAL";
    }

    if (event.type === "ASSISTANT_AUDIO_STOPPED" && this.terminalPlaybackActiveV18 && matchesTerminalIdentity) {
      this.terminalPlaybackActiveV18 = false;
      (this as any).diagnostics?.checkpoint?.("LIFECYCLE_TERMINAL_PLAYBACK_STOPPED_V18", {
        response_id: event.responseId,
        provider_kind: event.kind,
        correlated_kind: correlatedKind ?? null,
        authoritative_kind: "TERMINAL",
      });
      return "TERMINAL";
    }

    return correlatedKind === "HANDOFF" ? "NORMAL" : correlatedKind;
  }

  private releaseAssistantSpeechKindV18(event: RealtimeProviderEvent): void {
    if ((event.type === "ASSISTANT_AUDIO_STOPPED" || event.type === "ASSISTANT_AUDIO_CLEARED") && event.responseId) {
      this.assistantSpeechKindsByResponseIdV18.delete(event.responseId);
    }
  }

  private shouldQuarantineNonTerminalCloseEventV18(event: RealtimeProviderEvent): boolean {
    if (this.turnLifecycleV18.snapshot().state !== "TERMINAL_SPEAKING") return false;
    if (
      event.type !== "ASSISTANT_RESPONSE_STARTED" &&
      event.type !== "ASSISTANT_AUDIO_STARTED" &&
      event.type !== "ASSISTANT_AUDIO_STOPPED" &&
      event.type !== "ASSISTANT_AUDIO_CLEARED"
    ) return false;
    if (event.kind === "TERMINAL") return false;
    (this as any).diagnostics?.checkpoint?.("LIFECYCLE_NON_TERMINAL_EVENT_QUARANTINED_V18", {
      event_type: event.type,
      response_id: "responseId" in event ? event.responseId ?? null : null,
      kind: "kind" in event ? event.kind : null,
      terminal_response_id: this.terminalResponseIdV18,
    });
    return true;
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptRealtimeProviderEvents(data);
    for (const providerEvent of providerEvents) {
      this.rememberAssistantSpeechKindV18(providerEvent);

      if (providerEvent.type === "ASSISTANT_RESPONSE_STARTED" && this.presenceRequestPendingV18 && !this.presenceResponseIdV18 && providerEvent.purpose === "presence_recovery_v18") {
        this.presenceResponseIdV18 = providerEvent.responseId ?? null;
      }

      const adapted = adaptRealtimeTurnEvent(providerEvent);
      for (const lifecycleEvent of adapted) {
        if (lifecycleEvent.type === "assistant_audio_started" || lifecycleEvent.type === "assistant_audio_stopped" || lifecycleEvent.type === "assistant_audio_cleared") {
          const isPresenceAudio = Boolean(this.presenceResponseIdV18) && "responseId" in providerEvent && providerEvent.responseId === this.presenceResponseIdV18;
          const authoritativeKind = isPresenceAudio ? "PRESENCE" : this.lifecycleAssistantSpeechKindV18(providerEvent, lifecycleEvent.kind);
          this.dispatchLifecycleV18({ type: lifecycleEvent.type, kind: authoritativeKind ?? lifecycleEvent.kind });
        } else {
          this.dispatchLifecycleV18(lifecycleEvent);
        }
      }
      this.releaseAssistantSpeechKindV18(providerEvent);
    }

    if (providerEvents.some((event) => this.shouldQuarantineNonTerminalCloseEventV18(event))) return;

    await BasePrototype.handleRealtimeMessage.call(this, data);

    for (const providerEvent of providerEvents) {
      if (providerEvent.type === "ASSISTANT_AUDIO_STOPPED" && this.presenceResponseIdV18 && providerEvent.responseId === this.presenceResponseIdV18) {
        this.resetPresenceResponseStateV18();
      }
    }
  }
}
