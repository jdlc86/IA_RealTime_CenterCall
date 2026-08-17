import { CallSession as CallSessionV17 } from "./call-session-v17";
import { ConversationTurnLifecycle, type LifecycleEffect, type LifecycleEvent } from "./conversation-turn-lifecycle";
import { adaptRealtimeTurnEvent, type SyntheticRealtimeEvent } from "./realtime-turn-lifecycle-adapter";

const BaseConstructor = CallSessionV17 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV17.prototype as any;

const FIRST_PRESENCE_CHECK_MS = 8_000;
const MAX_UNANSWERED_WAIT_MS = 26_000;
const MAX_CALL_DURATION_MS = 15 * 60_000;

type RealtimeEvent = SyntheticRealtimeEvent & {
  response_id?: string;
  response?: { id?: string; metadata?: Record<string, unknown> | null };
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseRealtimeEvent(data: unknown): RealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEvent; } catch { return null; }
}

function responseId(event: RealtimeEvent | null): string | null {
  return event?.response_id ?? event?.response?.id ?? null;
}

/**
 * v18 now acts only as the runtime adapter/executor for ConversationTurnLifecycle.
 * The lifecycle is the single authority for caller/processing/waiting/presence
 * state. Timers are epoch-scoped effects; stale deadlines cannot act after caller
 * speech, while processing, or while Lucia is speaking.
 *
 * Business semantics remain owned by the semantic/tool layers. Irreversible
 * end-call and handoff authorization remain owned by v41/v43 and are deliberately
 * not inferred here from model tool choice.
 */
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
        authority: "ConversationTurnLifecycle",
        presence_check_ms: FIRST_PRESENCE_CHECK_MS,
        silence_close_ms: MAX_UNANSWERED_WAIT_MS,
        max_call_duration_ms: MAX_CALL_DURATION_MS,
        epoch_scoped_deadlines: true,
        legacy_presence_stages_removed: true,
      });
    }

    return response;
  }

  protected snapshotTurnLifecycleV18(): ReturnType<ConversationTurnLifecycle["snapshot"]> {
    return this.turnLifecycleV18.snapshot();
  }

  protected observeSemanticIgnoredV18(reason: string): void {
    this.dispatchLifecycleV18({ type: "semantic_ignored", reason });
  }

  /** Compatibility entry point for older layers. It no longer owns a timer. */
  protected armWaitingForUserV18(trigger: string): void {
    (this as any).diagnostics?.checkpoint?.("LEGACY_PRESENCE_REARM_IGNORED_V18", {
      trigger,
      authority: "ConversationTurnLifecycle",
      lifecycle_state: this.turnLifecycleV18.snapshot().state,
    });
  }

  /** Compatibility hook: useful caller evidence is already represented by lifecycle events. */
  protected refreshRecentUserPresenceV18(source: string): void {
    (this as any).diagnostics?.checkpoint?.("LEGACY_PRESENCE_REFRESH_IGNORED_V18", {
      source,
      authority: "ConversationTurnLifecycle",
      lifecycle_state: this.turnLifecycleV18.snapshot().state,
    });
  }

  private clearPresenceTimersV18(): void {
    if (this.presenceTimerV18 !== null) clearTimeout(this.presenceTimerV18);
    if (this.silenceCloseTimerV18 !== null) clearTimeout(this.silenceCloseTimerV18);
    this.presenceTimerV18 = null;
    this.silenceCloseTimerV18 = null;
  }

  private armSilenceEpochV18(epoch: number): void {
    this.clearPresenceTimersV18();
    this.presenceTimerV18 = setTimeout(() => {
      this.presenceTimerV18 = null;
      this.dispatchLifecycleV18({ type: "presence_deadline", epoch });
    }, FIRST_PRESENCE_CHECK_MS);
    this.silenceCloseTimerV18 = setTimeout(() => {
      this.silenceCloseTimerV18 = null;
      this.dispatchLifecycleV18({ type: "silence_close_deadline", epoch });
    }, MAX_UNANSWERED_WAIT_MS);
    (this as any).diagnostics?.checkpoint?.("LIFECYCLE_SILENCE_EPOCH_ARMED_V18", {
      epoch,
      presence_check_ms: FIRST_PRESENCE_CHECK_MS,
      silence_close_ms: MAX_UNANSWERED_WAIT_MS,
    });
  }

  private armMaxCallDurationV18(): void {
    if (this.maxCallTimerV18 !== null) clearTimeout(this.maxCallTimerV18);
    this.maxCallTimerV18 = setTimeout(() => {
      this.maxCallTimerV18 = null;
      this.dispatchLifecycleV18({ type: "max_call_duration" });
    }, MAX_CALL_DURATION_MS);
  }

  private issuePresenceCheckV18(): void {
    if (!(this as any).socket || (this as any).state === "closing" || (this as any).hangupStarted) return;
    this.presenceRequestPendingV18 = true;
    this.presenceResponseIdV18 = null;
    (this as any).diagnostics?.checkpoint?.("USER_PRESENCE_RECOVERY_REQUESTED", {
      lifecycle_state: this.turnLifecycleV18.snapshot().state,
      conversation: "none",
      isolated_from_agent_context: true,
      lifecycle_authority: true,
    });
    (this as any).send?.({
      type: "response.create",
      response: {
        conversation: "none",
        tool_choice: "none",
        metadata: { purpose: "presence_recovery_v18" },
        instructions: "Pronuncia exactamente esta frase y nada más: \"¿Sigues ahí?\". No respondas al historial y no llames herramientas.",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Pronuncia exactamente: ¿Sigues ahí?" }],
        }],
      },
    });
  }

  private executeLifecycleEffectV18(effect: LifecycleEffect): void {
    switch (effect.type) {
      case "ARM_SILENCE_TIMER":
        this.armSilenceEpochV18(effect.epoch);
        break;
      case "CANCEL_SILENCE_TIMER":
        this.clearPresenceTimersV18();
        break;
      case "SPEAK_PRESENCE_CHECK":
        this.issuePresenceCheckV18();
        break;
      case "SPEAK_IGNORED_RECOVERY":
        (this as any).send?.({
          type: "response.create",
          response: {
            conversation: "none",
            tool_choice: "none",
            metadata: { protected_speech_v35: "RECOVERY" },
            instructions: "Di brevemente: \"Perdona, no te he entendido. ¿Puedes repetirlo?\"",
          },
        });
        break;
      case "SPEAK_TERMINAL_FAREWELL":
        this.clearPresenceTimersV18();
        (this as any).diagnostics?.checkpoint?.("LIFECYCLE_TERMINAL_REQUESTED_V18", { reason: effect.reason });
        (this as any).beginClosing?.(effect.reason, "conversation_turn_lifecycle");
        break;
      case "HANGUP":
        this.clearPresenceTimersV18();
        (this as any).beginClosing?.("lifecycle_terminal_audio_stopped", "conversation_turn_lifecycle");
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
      event: event.type,
      before: before.state,
      after: after.state,
      silence_epoch: after.silenceEpoch,
      effects: effects.map((effect) => effect.type),
    });
    for (const effect of effects) this.executeLifecycleEffectV18(effect);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseRealtimeEvent(data);
    if (event) {
      if (event.type === "response.created" && this.presenceRequestPendingV18 && !this.presenceResponseIdV18) {
        this.presenceResponseIdV18 = responseId(event);
      }

      const adapted = adaptRealtimeTurnEvent(event);
      for (const lifecycleEvent of adapted) {
        if ((lifecycleEvent.type === "assistant_audio_started" || lifecycleEvent.type === "assistant_audio_stopped")
          && this.presenceResponseIdV18 && responseId(event) === this.presenceResponseIdV18) {
          this.dispatchLifecycleV18({ type: lifecycleEvent.type, kind: "PRESENCE" });
        } else {
          this.dispatchLifecycleV18(lifecycleEvent);
        }
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (event?.type === "output_audio_buffer.stopped" && this.presenceResponseIdV18 && responseId(event) === this.presenceResponseIdV18) {
      this.presenceRequestPendingV18 = false;
      this.presenceResponseIdV18 = null;
    }
  }
}
