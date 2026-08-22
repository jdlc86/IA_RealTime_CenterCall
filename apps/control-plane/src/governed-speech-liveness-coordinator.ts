import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import {
  observeRealtimeAssistantResponseCompleted,
  observeRealtimeAssistantResponseStarted,
} from "./realtime-provider-runtime.js";

type GovernedSpeechHost = object & {
  diagnostics?: {
    checkpoint?: (stage: string, details?: Record<string, unknown>) => void;
  };
};

/**
 * Composition boundary for governed post-tool speech liveness.
 *
 * This replaces the former V55 inheritance layer. It owns no conversation
 * state of its own: active-response/deferred-speech state remains in the
 * realtime provider runtime, while ResponseOwner reconciliation remains in V40.
 *
 * Ordering invariant:
 * - START is observed before lower CallSession layers process the event.
 * - COMPLETED is observed only after lower layers have processed the event, so
 *   ResponseOwner gets first authority to reconcile the completion.
 */
export function observeGovernedSpeechBeforeLowerLayers(
  host: GovernedSpeechHost,
  events: RealtimeProviderEvent[],
): void {
  const started = events.find((event) => event.type === "ASSISTANT_RESPONSE_STARTED");
  if (started?.type !== "ASSISTANT_RESPONSE_STARTED") return;
  observeRealtimeAssistantResponseStarted(host as any, started.responseId);
}

export function observeGovernedSpeechAfterLowerLayers(
  host: GovernedSpeechHost,
  events: RealtimeProviderEvent[],
): void {
  const completed = events.find((event) => event.type === "ASSISTANT_RESPONSE_COMPLETED");
  if (completed?.type !== "ASSISTANT_RESPONSE_COMPLETED") return;

  observeRealtimeAssistantResponseCompleted(host as any, completed.responseId);
  host.diagnostics?.checkpoint?.("GOVERNED_POST_TOOL_SPEECH_RELEASE_BOUNDARY_V55", {
    source: "assistant_response_completed",
    response_id: completed.responseId ?? null,
    timer_used: false,
    response_owner_reconciled_first: true,
    response_scoped_release: true,
    coordinator_composed: true,
    inheritance_layer_removed: true,
  });
}
