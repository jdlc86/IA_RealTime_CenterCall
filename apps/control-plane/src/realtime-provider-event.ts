import type { RealtimeInputDetectionSettings } from "./realtime-provider-command-port";

export type AssistantSpeechKind = "NORMAL" | "GREETING" | "RECOVERY" | "TERMINAL" | "PRESENCE";

export type RealtimeProviderEvent =
  | { type: "CALLER_SPEECH_STARTED" }
  | { type: "CALLER_SPEECH_STOPPED" }
  | { type: "CALLER_TRANSCRIPT_COMPLETED"; transcript: string }
  | { type: "INPUT_DETECTION_UPDATED"; present: boolean; settings: RealtimeInputDetectionSettings | null }
  | { type: "ASSISTANT_AUDIO_STARTED"; kind: AssistantSpeechKind; responseId?: string }
  | { type: "ASSISTANT_AUDIO_STOPPED"; kind: AssistantSpeechKind; responseId?: string }
  | { type: "ASSISTANT_AUDIO_CLEARED"; kind: AssistantSpeechKind; responseId?: string }
  | { type: "ASSISTANT_RESPONSE_STARTED"; kind: AssistantSpeechKind; responseId?: string; purpose?: string }
  | { type: "ASSISTANT_RESPONSE_COMPLETED"; kind: AssistantSpeechKind; responseId?: string; status?: string }
  | { type: "SEMANTIC_TOOL_SELECTED"; name: string; arguments?: string };
