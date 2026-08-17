import { CallSession as CallSessionV40 } from "./call-session-v40";

const BaseConstructor = CallSessionV40 as unknown as new (...args: any[]) => any;

/**
 * v41 is the narrow runtime bridge for confirmed barge-in.
 * v36 owns acoustic listening + OOB classification; v40 remains the sole
 * conversation lifecycle authority. This layer only converts a confirmed human
 * interruption into the existing objective lifecycle sequence.
 */
export class CallSession extends BaseConstructor {
  private confirmBargeInV40(): void {
    const session = this as any;
    session.dispatchLifecycleV40?.({ type: "assistant_audio_stopped", kind: "NORMAL" });
    session.dispatchLifecycleV40?.({ type: "speech_started" });
    session.dispatchLifecycleV40?.({ type: "speech_stopped" });
    session.dispatchLifecycleV40?.({ type: "transcript_usable" });
    session.armProcessingGuardV40?.();
    session.diagnostics?.checkpoint?.("CONFIRMED_BARGE_IN_LIFECYCLE_V41", {
      state: session.conversationLifecycleV40?.snapshot?.().state ?? null,
      processing_guard_armed: true,
    });
  }
}
