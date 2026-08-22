import type { AssistantSpeechKind, RealtimeProviderEvent } from "./realtime-provider-event";
import type { RealtimeInputDetectionSettings } from "./realtime-provider-command-port";

type OpenAITurnDetection = {
  type?: string;
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
  idle_timeout_ms?: number;
  create_response?: boolean;
  interrupt_response?: boolean;
} | null;

type OpenAIRealtimeEvent = {
  type?: string;
  name?: string;
  arguments?: string;
  transcript?: string;
  text?: string;
  call_id?: string;
  item_id?: string;
  response_id?: string;
  response?: { id?: string; status?: string; instructions?: string; metadata?: Record<string, unknown> | null };
  session?: { audio?: { input?: { turn_detection?: OpenAITurnDetection } } };
  error?: { event_id?: string; code?: string; message?: string };
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseOpenAIRealtimeEvent(data: unknown): OpenAIRealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as OpenAIRealtimeEvent; } catch { return null; }
}

function responseId(event: OpenAIRealtimeEvent): string | undefined {
  return event.response_id ?? event.response?.id;
}

function isLegacyTerminalFarewell(event: OpenAIRealtimeEvent): boolean {
  const instructions = event.response?.instructions;
  if (typeof instructions !== "string") return false;
  return instructions.includes("Esta es la despedida final.");
}

function assistantKind(event: OpenAIRealtimeEvent): AssistantSpeechKind {
  const metadata = event.response?.metadata ?? {};
  const protectedKind = metadata.protected_speech_v35;
  if (protectedKind === "GREETING") return "GREETING";
  if (protectedKind === "RECOVERY") return "RECOVERY";
  if (protectedKind === "TERMINAL") return "TERMINAL";
  if (metadata.human_handoff_v37) return "HANDOFF";
  const purpose = metadata.purpose;
  if (purpose === "presence_recovery_v18" || purpose === "presence_check") return "PRESENCE";
  if (purpose === "terminal_farewell" || purpose === "repeated_ignored_input_close") return "TERMINAL";
  // Compatibility for the v2 closing owner: response.created echoes the
  // response-local farewell instructions, so terminal identity can be bound to
  // the concrete response id instead of whichever audio happens to start next.
  if (isLegacyTerminalFarewell(event)) return "TERMINAL";
  return "NORMAL";
}

function inputDetectionSettings(turnDetection: Exclude<OpenAITurnDetection, null>): RealtimeInputDetectionSettings {
  return {
    threshold: turnDetection.threshold,
    prefixPaddingMs: turnDetection.prefix_padding_ms,
    silenceDurationMs: turnDetection.silence_duration_ms,
    idleTimeoutMs: turnDetection.idle_timeout_ms,
    createResponse: turnDetection.create_response,
    interruptResponse: turnDetection.interrupt_response,
  };
}

/** Translate OpenAI Realtime wire events into provider-neutral runtime events. */
export function adaptOpenAIRealtimeEvent(data: unknown): RealtimeProviderEvent[] {
  const event = parseOpenAIRealtimeEvent(data);
  if (!event) return [];

  switch (event.type) {
    case "session.created":
    case "session.updated": {
      const turnDetection = event.session?.audio?.input?.turn_detection;
      if (turnDetection === undefined) {
        return [{ type: "INPUT_DETECTION_UPDATED", present: false, settings: null }];
      }
      return [{
        type: "INPUT_DETECTION_UPDATED",
        present: true,
        settings: turnDetection === null ? null : inputDetectionSettings(turnDetection),
      }];
    }
    case "input_audio_buffer.speech_started": {
      const adapted: RealtimeProviderEvent = { type: "CALLER_SPEECH_STARTED" };
      if (event.item_id) adapted.itemId = event.item_id;
      return [adapted];
    }
    case "input_audio_buffer.speech_stopped":
      return [{ type: "CALLER_SPEECH_STOPPED" }];
    case "conversation.item.input_audio_transcription.completed": {
      const adapted: RealtimeProviderEvent = {
        type: "CALLER_TRANSCRIPT_COMPLETED",
        transcript: typeof event.transcript === "string" ? event.transcript : "",
      };
      if (event.item_id) adapted.itemId = event.item_id;
      return [adapted];
    }
    case "response.output_audio_transcript.done": {
      const adapted: RealtimeProviderEvent = {
        type: "ASSISTANT_TRANSCRIPT_COMPLETED",
        transcript: typeof event.transcript === "string" ? event.transcript : "",
      };
      const id = responseId(event);
      if (id) adapted.responseId = id;
      return [adapted];
    }
    case "response.output_text.done": {
      const adapted: RealtimeProviderEvent = {
        type: "TEXT_DECISION_COMPLETED",
        text: typeof event.text === "string" ? event.text : "",
      };
      const id = responseId(event);
      if (id) adapted.responseId = id;
      return [adapted];
    }
    case "output_audio_buffer.started":
      return [{ type: "ASSISTANT_AUDIO_STARTED", kind: assistantKind(event), responseId: responseId(event) }];
    case "output_audio_buffer.stopped":
      return [{ type: "ASSISTANT_AUDIO_STOPPED", kind: assistantKind(event), responseId: responseId(event) }];
    case "output_audio_buffer.cleared":
      return [{ type: "ASSISTANT_AUDIO_CLEARED", kind: assistantKind(event), responseId: responseId(event) }];
    case "response.created": {
      const metadata = event.response?.metadata ?? {};
      const purpose = metadata.purpose;
      const sourceItemId = metadata.source_item_id;
      return [{
        type: "ASSISTANT_RESPONSE_STARTED",
        kind: assistantKind(event),
        responseId: responseId(event),
        purpose: typeof purpose === "string" ? purpose : undefined,
        sourceItemId: typeof sourceItemId === "string" ? sourceItemId : undefined,
      }];
    }
    case "response.done":
      return [{
        type: "ASSISTANT_RESPONSE_COMPLETED",
        kind: assistantKind(event),
        responseId: responseId(event),
        status: typeof event.response?.status === "string" ? event.response.status : undefined,
      }];
    case "response.function_call_arguments.done": {
      if (!event.name) return [];
      const adapted: RealtimeProviderEvent = { type: "SEMANTIC_TOOL_SELECTED", name: event.name, arguments: event.arguments };
      if (event.call_id) adapted.callId = event.call_id;
      return [adapted];
    }
    case "error": {
      const adapted: Extract<RealtimeProviderEvent, { type: "PROVIDER_COMMAND_FAILED" }> = { type: "PROVIDER_COMMAND_FAILED" };
      if (event.error?.event_id) adapted.requestId = event.error.event_id;
      if (event.error?.code) adapted.code = event.error.code;
      if (event.error?.message) adapted.message = event.error.message;
      return [adapted];
    }
    default:
      return [];
  }
}
