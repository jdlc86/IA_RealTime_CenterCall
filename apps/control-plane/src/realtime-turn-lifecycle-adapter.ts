import { type IgnoredReason, type LifecycleEvent } from "./conversation-turn-lifecycle";

export type SyntheticRealtimeEvent = {
  type?: string;
  name?: string;
  arguments?: string;
  transcript?: string;
  response?: { metadata?: Record<string, unknown> | null };
};

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

function assistantKind(event: SyntheticRealtimeEvent): "NORMAL" | "GREETING" | "RECOVERY" | "TERMINAL" | "PRESENCE" {
  const metadata = event.response?.metadata ?? {};
  const protectedKind = metadata.protected_speech_v35;
  if (protectedKind === "GREETING") return "GREETING";
  if (protectedKind === "RECOVERY") return "RECOVERY";
  const purpose = metadata.purpose;
  if (purpose === "presence_recovery_v18" || purpose === "presence_check") return "PRESENCE";
  if (purpose === "terminal_farewell" || purpose === "repeated_ignored_input_close") return "TERMINAL";
  return "NORMAL";
}

/**
 * Pure mapping from Realtime-shaped events to ConversationTurnLifecycle events.
 * It intentionally performs no semantic classification. Model tool choice remains
 * the source of truth for coherent, ignored, out-of-scope and end-call turns.
 */
export function adaptRealtimeTurnEvent(event: SyntheticRealtimeEvent): LifecycleEvent[] {
  switch (event.type) {
    case "input_audio_buffer.speech_started":
      return [{ type: "speech_started" }];
    case "input_audio_buffer.speech_stopped":
      return [{ type: "speech_stopped" }];
    case "conversation.item.input_audio_transcription.completed":
      return [{ type: usableTranscript(event.transcript) ? "transcript_usable" : "transcript_unusable" }];
    case "output_audio_buffer.started":
      return [{ type: "assistant_audio_started", kind: assistantKind(event) }];
    case "output_audio_buffer.stopped":
      return [{ type: "assistant_audio_stopped", kind: assistantKind(event) }];
    case "response.function_call_arguments.done": {
      if (event.name === "restaurant_input_ignored") {
        return [{ type: "semantic_ignored", reason: ignoredReason(event.arguments) }];
      }
      if (event.name === "restaurant_out_of_scope") return [{ type: "out_of_scope" }];
      if (event.name === "restaurant_end_call") return [{ type: "end_call" }];
      if (event.name === "restaurant_human_assistance") return [{ type: "handoff_started" }];
      if (event.name && PUBLIC_SEMANTIC_TOOLS.has(event.name)) return [{ type: "semantic_valid", tool: event.name }];
      return [];
    }
    default:
      return [];
  }
}
