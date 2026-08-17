import { type IgnoredReason, type LifecycleEvent } from "./conversation-turn-lifecycle";
import type { RealtimeProviderEvent } from "./realtime-provider-event";

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
      return [{ type: "assistant_audio_started", kind: event.kind }];
    case "ASSISTANT_AUDIO_STOPPED":
      return [{ type: "assistant_audio_stopped", kind: event.kind }];
    case "SEMANTIC_TOOL_SELECTED": {
      if (event.name === "restaurant_input_ignored") {
        return [{ type: "semantic_ignored", reason: ignoredReason(event.arguments) }];
      }
      if (event.name === "restaurant_out_of_scope") return [{ type: "out_of_scope" }];
      if (PUBLIC_SEMANTIC_TOOLS.has(event.name)) return [{ type: "semantic_valid", tool: event.name }];
      return [];
    }
    case "ASSISTANT_RESPONSE_STARTED":
      return [];
  }
}
