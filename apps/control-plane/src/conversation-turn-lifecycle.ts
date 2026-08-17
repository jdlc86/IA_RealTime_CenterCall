export type TurnState =
  | "LUCIA_SPEAKING"
  | "WAITING_FOR_CALLER"
  | "CALLER_SPEAKING"
  | "PROCESSING_CALLER_TURN"
  | "IGNORED_RECOVERY_SPEAKING"
  | "TERMINAL_SPEAKING"
  | "HANDOFF"
  | "CLOSING";

export type IgnoredReason =
  | "INCOHERENT"
  | "BACKGROUND_SPEECH"
  | "NOT_DIRECTED_TO_ASSISTANT"
  | "ECHO"
  | "UNCERTAIN"
  | "SILENCE"
  | string;

export type LifecycleEvent =
  | { type: "assistant_audio_started"; kind?: "NORMAL" | "GREETING" | "RECOVERY" | "TERMINAL" | "PRESENCE" }
  | { type: "assistant_audio_stopped"; kind?: "NORMAL" | "GREETING" | "RECOVERY" | "TERMINAL" | "PRESENCE" }
  | { type: "speech_started" }
  | { type: "speech_stopped" }
  | { type: "transcript_usable" }
  | { type: "transcript_unusable" }
  | { type: "semantic_valid"; tool?: string }
  | { type: "semantic_ignored"; reason: IgnoredReason }
  | { type: "out_of_scope" }
  | { type: "presence_deadline"; epoch: number }
  | { type: "silence_close_deadline"; epoch: number }
  | { type: "acoustic_guard_expired" }
  | { type: "processing_guard_expired" }
  | { type: "handoff_started" }
  | { type: "handoff_completed" }
  | { type: "end_call" }
  | { type: "max_call_duration" };

export type LifecycleEffect =
  | { type: "ARM_SILENCE_TIMER"; epoch: number }
  | { type: "CANCEL_SILENCE_TIMER"; epoch: number }
  | { type: "SPEAK_PRESENCE_CHECK" }
  | { type: "SPEAK_IGNORED_RECOVERY"; protected: true }
  | { type: "SPEAK_TERMINAL_FAREWELL"; protected: true; reason: string }
  | { type: "RESET_IGNORED_COUNT" }
  | { type: "IGNORED_COUNT_CHANGED"; count: number }
  | { type: "SUSPEND_FOR_HANDOFF" }
  | { type: "HANGUP" };

export type LifecycleSnapshot = {
  state: TurnState;
  ignoredCount: number;
  silenceEpoch: number;
  silenceTimerArmed: boolean;
  presenceCheckIssued: boolean;
};

const COUNTED_IGNORED = new Set([
  "INCOHERENT",
  "BACKGROUND_SPEECH",
  "NOT_DIRECTED_TO_ASSISTANT",
  "ECHO",
  "UNCERTAIN",
]);

export class ConversationTurnLifecycle {
  private state: TurnState = "LUCIA_SPEAKING";
  private ignoredCount = 0;
  private silenceEpoch = 0;
  private silenceTimerArmed = false;
  private presenceCheckIssued = false;

  snapshot(): LifecycleSnapshot {
    return {
      state: this.state,
      ignoredCount: this.ignoredCount,
      silenceEpoch: this.silenceEpoch,
      silenceTimerArmed: this.silenceTimerArmed,
      presenceCheckIssued: this.presenceCheckIssued,
    };
  }

  dispatch(event: LifecycleEvent): LifecycleEffect[] {
    const effects: LifecycleEffect[] = [];

    if (this.state === "CLOSING") return effects;

    if (this.state === "TERMINAL_SPEAKING") {
      if (event.type === "assistant_audio_started" && event.kind === "TERMINAL") return effects;
      if (event.type === "assistant_audio_stopped" && event.kind === "TERMINAL") {
        this.state = "CLOSING";
        effects.push({ type: "HANGUP" });
      }
      return effects;
    }

    if (this.state === "HANDOFF") return effects;

    if (event.type === "max_call_duration") {
      this.cancelSilence(effects);
      this.state = "TERMINAL_SPEAKING";
      effects.push({ type: "SPEAK_TERMINAL_FAREWELL", protected: true, reason: "max_call_duration" });
      return effects;
    }

    if (event.type === "handoff_started") {
      this.cancelSilence(effects);
      this.state = "HANDOFF";
      effects.push({ type: "SUSPEND_FOR_HANDOFF" });
      return effects;
    }

    if (event.type === "end_call") {
      this.cancelSilence(effects);
      this.state = "TERMINAL_SPEAKING";
      effects.push({ type: "SPEAK_TERMINAL_FAREWELL", protected: true, reason: "end_call" });
      return effects;
    }

    switch (event.type) {
      case "assistant_audio_started": {
        if (event.kind === "PRESENCE") return effects;
        if ((event.kind === undefined || event.kind === "NORMAL") && this.state === "PROCESSING_CALLER_TURN" && this.ignoredCount !== 0) {
          this.ignoredCount = 0;
          effects.push({ type: "RESET_IGNORED_COUNT" });
        }
        this.cancelSilence(effects);
        if (event.kind === "RECOVERY") this.state = "IGNORED_RECOVERY_SPEAKING";
        else if (event.kind === "TERMINAL") this.state = "TERMINAL_SPEAKING";
        else this.state = "LUCIA_SPEAKING";
        return effects;
      }
      case "assistant_audio_stopped": {
        if (event.kind === "TERMINAL" || event.kind === "PRESENCE") return effects;
        this.state = "WAITING_FOR_CALLER";
        this.armFreshSilence(effects);
        return effects;
      }
      case "speech_started": {
        if (this.state !== "WAITING_FOR_CALLER") return effects;
        this.cancelSilence(effects);
        this.state = "CALLER_SPEAKING";
        return effects;
      }
      case "speech_stopped": {
        if (this.state === "CALLER_SPEAKING") this.state = "PROCESSING_CALLER_TURN";
        return effects;
      }
      case "transcript_usable": {
        if (this.state === "CALLER_SPEAKING" || this.state === "PROCESSING_CALLER_TURN") this.state = "PROCESSING_CALLER_TURN";
        return effects;
      }
      case "transcript_unusable":
      case "acoustic_guard_expired":
      case "processing_guard_expired": {
        if (this.state === "CALLER_SPEAKING" || this.state === "PROCESSING_CALLER_TURN") {
          this.state = "WAITING_FOR_CALLER";
          this.armFreshSilence(effects);
        }
        return effects;
      }
      case "semantic_valid":
      case "out_of_scope": {
        if (this.ignoredCount !== 0) {
          this.ignoredCount = 0;
          effects.push({ type: "RESET_IGNORED_COUNT" });
        }
        this.cancelSilence(effects);
        this.state = "LUCIA_SPEAKING";
        return effects;
      }
      case "semantic_ignored": {
        if (event.reason === "SILENCE") {
          this.state = "WAITING_FOR_CALLER";
          this.armFreshSilence(effects);
          return effects;
        }
        if (!COUNTED_IGNORED.has(event.reason)) {
          this.state = "WAITING_FOR_CALLER";
          this.armFreshSilence(effects);
          return effects;
        }
        this.ignoredCount += 1;
        effects.push({ type: "IGNORED_COUNT_CHANGED", count: this.ignoredCount });
        this.cancelSilence(effects);
        if (this.ignoredCount === 1) {
          this.state = "WAITING_FOR_CALLER";
          this.armFreshSilence(effects);
          return effects;
        }
        if (this.ignoredCount === 2) {
          this.state = "IGNORED_RECOVERY_SPEAKING";
          effects.push({ type: "SPEAK_IGNORED_RECOVERY", protected: true });
          return effects;
        }
        this.state = "TERMINAL_SPEAKING";
        effects.push({ type: "SPEAK_TERMINAL_FAREWELL", protected: true, reason: "repeated_ignored_input" });
        return effects;
      }
      case "presence_deadline": {
        if (this.state !== "WAITING_FOR_CALLER" || !this.silenceTimerArmed || event.epoch !== this.silenceEpoch || this.presenceCheckIssued) return effects;
        this.presenceCheckIssued = true;
        effects.push({ type: "SPEAK_PRESENCE_CHECK" });
        return effects;
      }
      case "silence_close_deadline": {
        if (this.state !== "WAITING_FOR_CALLER" || !this.silenceTimerArmed || event.epoch !== this.silenceEpoch) return effects;
        this.cancelSilence(effects);
        this.state = "TERMINAL_SPEAKING";
        effects.push({ type: "SPEAK_TERMINAL_FAREWELL", protected: true, reason: "silence_timeout" });
        return effects;
      }
      default:
        return effects;
    }
  }

  private armFreshSilence(effects: LifecycleEffect[]): void {
    if (this.state !== "WAITING_FOR_CALLER") return;
    if (this.silenceTimerArmed) effects.push({ type: "CANCEL_SILENCE_TIMER", epoch: this.silenceEpoch });
    this.silenceEpoch += 1;
    this.silenceTimerArmed = true;
    this.presenceCheckIssued = false;
    effects.push({ type: "ARM_SILENCE_TIMER", epoch: this.silenceEpoch });
  }

  private cancelSilence(effects: LifecycleEffect[]): void {
    if (!this.silenceTimerArmed) return;
    effects.push({ type: "CANCEL_SILENCE_TIMER", epoch: this.silenceEpoch });
    this.silenceTimerArmed = false;
    this.presenceCheckIssued = false;
  }
}
