import { CallSession as CallSessionV41 } from "./call-session-v41";

const BaseConstructor = CallSessionV41 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV41.prototype as any;

export function shouldQuiesceConversationLifecycleV42(state: unknown, hangupStarted: unknown): boolean {
  return state === "closing" || hangupStarted === true;
}

/**
 * v42 closes the lifecycle ownership gap between the legacy explicit-farewell
 * path (restaurant_end_call / beginClosing / performHangup) and v40 timers.
 *
 * v40 intentionally does not own restaurant_end_call because v23 already owns
 * the spoken farewell and transport hangup. After that lower layer starts
 * closing, however, an output_audio_buffer.stopped event can make v40 look like
 * it returned to WAITING_FOR_CALLER and arm fresh silence timers. v42 treats
 * the lower runtime's closing state as authoritative and immediately quiesces
 * every v40 timer after the base event has been processed.
 *
 * This layer emits no speech, creates no response and performs no hangup. It is
 * cleanup-only, so barge-in, reservations and the v40 silence policy remain
 * unchanged.
 */
export class CallSession extends BaseConstructor {
  private lifecycleQuiescedV42 = false;

  private quiesceConversationLifecycleV42(reason: string): void {
    const session = this as any;
    session.clearSilenceTimersV40?.();
    session.clearProcessingGuardV40?.();
    session.clearMaxCallTimerV40?.();

    if (!this.lifecycleQuiescedV42) {
      this.lifecycleQuiescedV42 = true;
      session.diagnostics?.checkpoint?.("CONVERSATION_LIFECYCLE_QUIESCED_V42", {
        reason,
        state: session.state ?? null,
        hangup_started: session.hangupStarted === true,
        timers_cancelled: true,
      });
    }
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    await BasePrototype.handleRealtimeMessage.call(this, data);

    const session = this as any;
    if (shouldQuiesceConversationLifecycleV42(session.state, session.hangupStarted)) {
      this.quiesceConversationLifecycleV42(
        session.state === "closing" ? "runtime_closing" : "hangup_started",
      );
    }
  }
}
