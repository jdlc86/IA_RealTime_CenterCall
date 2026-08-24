import type { RealtimeSpeechRequest } from "./realtime-provider-command-port.js";
import type { AssistantSpeechKind } from "./realtime-provider-event.js";

export type GeminiGovernedSpeechDescriptor = Readonly<{
  responseId: string;
  text: string;
  kind: AssistantSpeechKind;
  purpose?: string;
}>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function governedKind(request: RealtimeSpeechRequest): AssistantSpeechKind {
  const protectedValue = request.metadata?.protected_speech_v35;
  if (protectedValue != null) {
    if (protectedValue === "GREETING" || protectedValue === "RECOVERY") return protectedValue;
    throw new Error("Gemini governed speech protected kind is unsupported");
  }

  const handoffValue = request.metadata?.human_handoff_v37;
  if (handoffValue != null) {
    if (handoffValue === "ANNOUNCEMENT" || handoffValue === "FAILURE_TERMINAL") return "HANDOFF";
    throw new Error("Gemini governed speech handoff kind is unsupported");
  }

  if (request.purpose === "presence_recovery_v18" || request.purpose === "presence_check") return "PRESENCE";
  if (request.purpose === "terminal_farewell" || request.purpose === "repeated_ignored_input_close") return "TERMINAL";
  return "NORMAL";
}

export function geminiGovernedSpeechDescriptor(
  request: RealtimeSpeechRequest,
  createId: () => string = () => crypto.randomUUID(),
): GeminiGovernedSpeechDescriptor {
  const text = required(request?.exactText, "Gemini governed speech exact text");
  const responseId = request?.requestId
    ? required(request.requestId, "Gemini governed speech response id")
    : `gemini_governed_speech_${required(createId(), "Gemini governed speech generated id")}`;
  const purpose = request?.purpose == null ? undefined : required(request.purpose, "Gemini governed speech purpose");
  return Object.freeze({
    responseId,
    text,
    kind: governedKind(request),
    ...(purpose ? { purpose } : {}),
  });
}
