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

function protectedKind(request: RealtimeSpeechRequest): AssistantSpeechKind {
  const value = request.metadata?.protected_speech_v35;
  if (value == null) return "NORMAL";
  if (value === "GREETING" || value === "RECOVERY") return value;
  throw new Error("Gemini governed speech protected kind is unsupported");
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
    kind: protectedKind(request),
    ...(purpose ? { purpose } : {}),
  });
}
