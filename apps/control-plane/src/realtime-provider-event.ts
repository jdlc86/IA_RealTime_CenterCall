export type AssistantSpeechKind = "NORMAL" | "GREETING" | "RECOVERY" | "TERMINAL" | "PRESENCE";

export type RealtimeProviderEvent =
  | { type: "CALLER_SPEECH_STARTED" }
  | { type: "CALLER_SPEECH_STOPPED" }
  | { type: "CALLER_TRANSCRIPT_COMPLETED"; transcript: string }
  | { type: "ASSISTANT_AUDIO_STARTED"; kind: AssistantSpeechKind; responseId?: string }
  | { type: "ASSISTANT_AUDIO_STOPPED"; kind: AssistantSpeechKind; responseId?: string }
  | { type: "ASSISTANT_RESPONSE_STARTED"; responseId?: string; purpose?: string }
  | { type: "SEMANTIC_TOOL_SELECTED"; name: string; arguments?: string };
