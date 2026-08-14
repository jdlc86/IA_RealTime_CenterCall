import { CallSession as CallSessionV17 } from "./call-session-v17";

const BaseConstructor = CallSessionV17 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV17.prototype as any;

const FIRST_PRESENCE_CHECK_MS = 8_000;
const SECOND_PRESENCE_CHECK_MS = 16_000;
const MAX_UNANSWERED_WAIT_MS = 26_000;
const MAX_CALL_DURATION_MS = 15 * 60_000;
const ACTIVE_SPEECH_RECHECK_MS = 750;

const AGENT_BUSINESS_TOOLS = new Set([
  "restaurant_reservation_create",
  "restaurant_reservation_query",
  "restaurant_reservation_modify",
  "restaurant_reservation_cancel",
  "restaurant_business_info",
  "restaurant_marketing_preferences",
  "restaurant_end_call",
  "restaurant_out_of_scope",
]);

type RealtimeEvent = {
  type?: string;
  name?: string;
  response_id?: string;
  transcript?: string;
  response?: { id?: string };
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

/**
 * v18 adds a runtime-only presence/cost boundary.
 *
 * Important invariants:
 * - VAD/audio alone never resets inactivity.
 * - A user turn becomes valid only when Lucia reacts coherently (speech) or selects
 *   a concrete agent tool.
 * - Recovery prompts never reset the original inactivity deadline.
 * - Tool execution suspends the relative user-turn watchdog; the absolute call
 *   duration limit remains armed.
 */
export class CallSession extends BaseConstructor {
  private inactivityStartedAtV18: number | null = null;
  private inactivityTimerV18: ReturnType<typeof setTimeout> | null = null;
  private maxCallTimerV18: ReturnType<typeof setTimeout> | null = null;
  private presenceStageV18: 0 | 1 | 2 = 0;
  private userAudioActiveV18 = false;
  private userTurnObservedV18 = false;
  private recoverySpeechInFlightV18 = false;
  private recoveryResponseIdV18: string | null = null;
  private toolExecutionActiveV18 = false;
  private watchdogInstalledV18 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);

    if (isStart && response.ok && !this.watchdogInstalledV18) {
      this.watchdogInstalledV18 = true;
      this.armMaxCallDurationV18();
      (this as any).diagnostics?.checkpoint?.("USER_TURN_WATCHDOG_V18_ENABLED", {
        first_presence_check_ms: FIRST_PRESENCE_CHECK_MS,
        second_presence_check_ms: SECOND_PRESENCE_CHECK_MS,
        max_unanswered_wait_ms: MAX_UNANSWERED_WAIT_MS,
        max_call_duration_ms: MAX_CALL_DURATION_MS,
        vad_resets_inactivity: false,
        coherent_lucia_reaction_required: true,
      });
    }

    return response;
  }

  private clearInactivityTimerV18(): void {
    if (this.inactivityTimerV18 !== null) {
      clearTimeout(this.inactivityTimerV18);
      this.inactivityTimerV18 = null;
    }
  }

  private clearMaxCallTimerV18(): void {
    if (this.maxCallTimerV18 !== null) {
      clearTimeout(this.maxCallTimerV18);
      this.maxCallTimerV18 = null;
    }
  }

  private armMaxCallDurationV18(): void {
    this.clearMaxCallTimerV18();
    this.maxCallTimerV18 = setTimeout(() => {
      this.maxCallTimerV18 = null;
      if (!(this as any).socket || (this as any).hangupStarted || (this as any).state === "closing") return;
      this.clearInactivityTimerV18();
      (this as any).diagnostics?.checkpoint?.("MAX_CALL_DURATION_REACHED", {
        max_call_duration_ms: MAX_CALL_DURATION_MS,
        reason: "cost_guard",
      });
      (this as any).beginClosing?.("max_call_duration_reached", "runtime_cost_watchdog_v18");
    }, MAX_CALL_DURATION_MS);
  }

  private armWaitingForUserV18(trigger: string): void {
    if (this.toolExecutionActiveV18 || (this as any).state === "closing" || (this as any).hangupStarted) return;
    this.clearInactivityTimerV18();
    this.inactivityStartedAtV18 = Date.now();
    this.presenceStageV18 = 0;
    this.userTurnObservedV18 = false;
    this.recoverySpeechInFlightV18 = false;
    this.recoveryResponseIdV18 = null;
    (this as any).diagnostics?.checkpoint?.("WAITING_FOR_USER_TURN_ARMED", {
      trigger,
      absolute_unanswered_deadline_ms: MAX_UNANSWERED_WAIT_MS,
    });
    this.scheduleNextInactivityCheckV18();
  }

  private suspendForToolV18(tool: string): void {
    this.toolExecutionActiveV18 = true;
    this.clearInactivityTimerV18();
    this.inactivityStartedAtV18 = null;
    this.presenceStageV18 = 0;
    (this as any).diagnostics?.checkpoint?.("USER_TURN_WATCHDOG_SUSPENDED_FOR_TOOL", { tool });
  }

  private validateUserTurnV18(source: string): void {
    if (!this.userTurnObservedV18 && source !== "agent_tool") return;
    const elapsed = this.inactivityStartedAtV18 === null ? null : Date.now() - this.inactivityStartedAtV18;
    this.clearInactivityTimerV18();
    this.inactivityStartedAtV18 = null;
    this.presenceStageV18 = 0;
    this.userTurnObservedV18 = false;
    this.recoverySpeechInFlightV18 = false;
    this.recoveryResponseIdV18 = null;
    (this as any).diagnostics?.checkpoint?.("USER_TURN_VALIDATED_BY_LUCIA", {
      source,
      unanswered_elapsed_ms: elapsed,
      vad_only: false,
    });
  }

  private scheduleNextInactivityCheckV18(): void {
    this.clearInactivityTimerV18();
    if (this.inactivityStartedAtV18 === null || this.toolExecutionActiveV18) return;
    const elapsed = Date.now() - this.inactivityStartedAtV18;
    const target = this.presenceStageV18 === 0
      ? FIRST_PRESENCE_CHECK_MS
      : this.presenceStageV18 === 1
        ? SECOND_PRESENCE_CHECK_MS
        : MAX_UNANSWERED_WAIT_MS;
    const delay = Math.max(0, target - elapsed);
    this.inactivityTimerV18 = setTimeout(() => {
      this.inactivityTimerV18 = null;
      this.onInactivityDeadlineV18();
    }, delay);
  }

  private onInactivityDeadlineV18(): void {
    if (this.inactivityStartedAtV18 === null || this.toolExecutionActiveV18) return;
    if (!(this as any).socket || (this as any).state === "closing" || (this as any).hangupStarted) {
      this.clearInactivityTimerV18();
      return;
    }

    const elapsed = Date.now() - this.inactivityStartedAtV18;
    if (elapsed >= MAX_UNANSWERED_WAIT_MS) {
      this.clearInactivityTimerV18();
      (this as any).diagnostics?.checkpoint?.("USER_TURN_INACTIVITY_CLOSE", {
        elapsed_ms: elapsed,
        presence_attempts: this.presenceStageV18,
        reason: "no_coherent_user_turn",
      });
      (this as any).beginClosing?.("user_inactivity_timeout", "runtime_user_turn_watchdog_v18");
      return;
    }

    // Never talk over actual detected speech, but do not reset the absolute clock.
    if (this.userAudioActiveV18) {
      (this as any).diagnostics?.checkpoint?.("USER_TURN_WATCHDOG_DEFERRED_ACTIVE_AUDIO", {
        elapsed_ms: elapsed,
        stage: this.presenceStageV18,
        resets_deadline: false,
      });
      this.inactivityTimerV18 = setTimeout(() => {
        this.inactivityTimerV18 = null;
        this.onInactivityDeadlineV18();
      }, ACTIVE_SPEECH_RECHECK_MS);
      return;
    }

    if (this.presenceStageV18 === 0) {
      this.presenceStageV18 = 1;
      this.issuePresenceRecoveryV18("Di exactamente: ¿Sigues ahí?");
      return;
    }

    if (this.presenceStageV18 === 1) {
      this.presenceStageV18 = 2;
      this.issuePresenceRecoveryV18("Di exactamente: ¿Me escuchas?");
      return;
    }

    this.scheduleNextInactivityCheckV18();
  }

  private issuePresenceRecoveryV18(instructions: string): void {
    this.recoverySpeechInFlightV18 = true;
    this.recoveryResponseIdV18 = null;
    (this as any).diagnostics?.checkpoint?.("USER_PRESENCE_RECOVERY_REQUESTED", {
      stage: this.presenceStageV18,
      resets_inactivity: false,
    });
    (this as any).createSpokenResponse?.(`${instructions} No añadas nada más. Esto es una comprobación de presencia, no una intención de cierre.`);
    // Keep the original absolute clock alive even if playback callbacks are delayed.
    this.scheduleNextInactivityCheckV18();
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "input_audio_buffer.speech_started") {
      this.userAudioActiveV18 = true;
      this.userTurnObservedV18 = true;
      (this as any).diagnostics?.checkpoint?.("USER_AUDIO_DETECTED_NO_RESET", {
        inactivity_reset: false,
        reason: "vad_is_not_semantic_evidence",
      });
    }

    if (event?.type === "input_audio_buffer.speech_stopped") {
      this.userAudioActiveV18 = false;
    }

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      this.userAudioActiveV18 = false;
      this.userTurnObservedV18 = true;
    }

    if (event?.type === "response.function_call_arguments.done" && event.name && AGENT_BUSINESS_TOOLS.has(event.name)) {
      // Tool selection is Lucia's semantic decision, so it validates the turn.
      this.validateUserTurnV18("agent_tool");
      this.suspendForToolV18(event.name);
    }

    if (event?.type === "response.created" && this.recoverySpeechInFlightV18 && !this.recoveryResponseIdV18) {
      this.recoveryResponseIdV18 = event.response_id ?? event.response?.id ?? null;
    }

    if (event?.type === "response.output_audio_transcript.done") {
      const isRecovery = this.recoverySpeechInFlightV18
        && (!this.recoveryResponseIdV18 || !event.response_id || event.response_id === this.recoveryResponseIdV18);
      if (!isRecovery && this.userTurnObservedV18) {
        // Lucia chose to produce a coherent conversational answer to the detected turn.
        this.validateUserTurnV18("lucia_spoken_response");
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (event?.type === "output_audio_buffer.stopped") {
      const isRecovery = this.recoverySpeechInFlightV18
        && (!this.recoveryResponseIdV18 || !event.response_id || event.response_id === this.recoveryResponseIdV18);
      if (isRecovery) {
        this.recoverySpeechInFlightV18 = false;
        this.recoveryResponseIdV18 = null;
        this.scheduleNextInactivityCheckV18();
      } else if ((this as any).state !== "closing" && !(this as any).hangupStarted) {
        // Any completed non-recovery Lucia turn hands control back to the caller.
        this.toolExecutionActiveV18 = false;
        this.armWaitingForUserV18("assistant_audio_completed");
      }
    }
  }
}
