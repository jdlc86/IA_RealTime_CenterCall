import { type IgnoredReason, type LifecycleEvent } from "./conversation-turn-lifecycle";
import type { AssistantSpeechKind, RealtimeProviderEvent } from "./realtime-provider-event";

const PUBLIC_SEMANTIC_TOOLS = new Set([
  "restaurant_business_info",
  "restaurant_menu",
  "restaurant_hours",
  "restaurant_reservation_search",
  "restaurant_reservation_create",
  "restaurant_reservation_query",
  "restaurant_reservation_modify",
  "restaurant_reservation_cancel",
  "restaurant_marketing_preferences",
  "restaurant_human_assistance",
  "restaurant_out_of_scope",
  "restaurant_end_call",
]);

type LifecycleAssistantSpeechKind = NonNullable<Extract<LifecycleEvent, { type: "assistant_audio_started" }>["kind"]>;

function usableTranscript(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\s+/g, " ").trim().length > 0;
}

function ignoredReason(args: unknown): IgnoredReason {
  if (typeof args !== "string" || !args.trim()) return "UNCERTAIN";
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    return typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "UNCERTAIN";
  } catch {
    return "UNCERTAIN";
  }
}

/**
 * The conversation lifecycle intentionally does not own protected handoff speech.
 * Before Gate B handoff announcements reached this adapter as NORMAL while v40/v44
 * protected them through provider metadata. Preserve that lifecycle behavior while
 * allowing the provider-neutral event layer to expose HANDOFF to the barge-in owner.
 */
function lifecycleAssistantSpeechKind(kind: AssistantSpeechKind): LifecycleAssistantSpeechKind {
  return kind === "HANDOFF" ? "NORMAL" : kind;
}

/** Provider-neutral realtime event -> lifecycle mapping. */
export function adaptRealtimeTurnEvent(event: RealtimeProviderEvent): LifecycleEvent[] {
  switch (event.type) {
    case "CALLER_SPEECH_STARTED":
      return [{ type: "speech_started" }];
    case "CALLER_SPEECH_STOPPED":
      return [{ type: "speech_stopped" }];
    case "CALLER_TRANSCRIPT_COMPLETED":
      return [{ type: usableTranscript(event.transcript) ? "transcript_usable" : "transcript_unusable" }];
    case "ASSISTANT_AUDIO_STARTED":
      return [{ type: "assistant_audio_started", kind: lifecycleAssistantSpeechKind(event.kind) }];
    case "ASSISTANT_AUDIO_STOPPED":
      return [{ type: "assistant_audio_stopped", kind: lifecycleAssistantSpeechKind(event.kind) }];
    case "ASSISTANT_AUDIO_CLEARED":
      return [{ type: "assistant_audio_cleared", kind: lifecycleAssistantSpeechKind(event.kind) }];
    case "SEMANTIC_TOOL_SELECTED": {
      if (event.name === "restaurant_input_ignored") {
        return [{ type: "semantic_ignored", reason: ignoredReason(event.arguments) }];
      }
      if (event.name === "restaurant_out_of_scope") return [{ type: "out_of_scope" }];
      if (PUBLIC_SEMANTIC_TOOLS.has(event.name)) return [{ type: "semantic_valid", tool: event.name }];
      return [];
    }
    case "ASSISTANT_RESPONSE_STARTED":
    case "ASSISTANT_RESPONSE_COMPLETED":
    case "ASSISTANT_TRANSCRIPT_COMPLETED":
    case "TEXT_DECISION_COMPLETED":
    case "INPUT_DETECTION_UPDATED":
    case "PROVIDER_COMMAND_FAILED":
      return [];
  }
}
