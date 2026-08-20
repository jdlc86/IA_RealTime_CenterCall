import type { RealtimeInputDetectionSettings } from "./realtime-provider-command-port";

export type AssistantSpeechKind = "NORMAL" | "GREETING" | "RECOVERY" | "TERMINAL" | "PRESENCE" | "HANDOFF";

export type RealtimeProviderEvent =
  | { type: "CALLER_SPEECH_STARTED"; itemId?: string }
  | { type: "CALLER_SPEECH_STOPPED" }
  | { type: "CALLER_TRANSCRIPT_COMPLETED"; transcript: string; itemId?: string }
  | { type: "ASSISTANT_TRANSCRIPT_COMPLETED"; transcript: string; responseId?: string }
  | { type: "INPUT_DETECTION_UPDATED"; present: boolean; settings: RealtimeInputDetectionSettings | null }
  | { type: "ASSISTANT_AUDIO_STARTED"; kind: AssistantSpeechKind; responseId?: string }
  | { type: "ASSISTANT_AUDIO_STOPPED"; kind: AssistantSpeechKind; responseId?: string }
  | { type: "ASSISTANT_AUDIO_CLEARED"; kind: AssistantSpeechKind; responseId?: string }
  | { type: "ASSISTANT_RESPONSE_STARTED"; kind: AssistantSpeechKind; responseId?: string; purpose?: string; sourceItemId?: string }
  | { type: "ASSISTANT_RESPONSE_COMPLETED"; kind: AssistantSpeechKind; responseId?: string; status?: string }
  | { type: "TEXT_DECISION_COMPLETED"; responseId?: string; text: string }
  | { type: "SEMANTIC_TOOL_SELECTED"; name: string; arguments?: string; callId?: string }
  | { type: "PROVIDER_COMMAND_FAILED"; requestId?: string; code?: string; message?: string };
