import { CallSession as CallSessionV54 } from "./call-session-v54-close-confirmation-authority";
import {
  adaptRealtimeProviderEvents,
  observeRealtimeAssistantResponseCompleted,
  observeRealtimeAssistantResponseStarted,
} from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV54 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV54.prototype as any;

/**
 * V55 closes the post-tool liveness race observed when a public tool completes
 * while the response that selected that tool is still active.
 *
 * A governed replacement speech (for example V26 MISSING_INFORMATION) must not
 * create a second realtime response until the active tool-calling response has
 * completed. The provider runtime queues that speech; this layer supplies the
 * response lifecycle boundary needed to release it deterministically.
 *
 * No timer/watchdog participates in normal release.
 */
export class CallSession extends BaseConstructor {
  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const events = adaptRealtimeProviderEvents(data);
    const started = events.some((event) => event.type === "ASSISTANT_RESPONSE_STARTED");
    const completed = events.some((event) => event.type === "ASSISTANT_RESPONSE_COMPLETED");

    if (started) observeRealtimeAssistantResponseStarted(this as any);

    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (completed) {
      observeRealtimeAssistantResponseCompleted(this as any);
      (this as any).diagnostics?.checkpoint?.("GOVERNED_POST_TOOL_SPEECH_RELEASE_BOUNDARY_V55", {
        source: "assistant_response_completed",
        timer_used: false,
        response_owner_reconciled_first: true,
      });
    }
  }
}
