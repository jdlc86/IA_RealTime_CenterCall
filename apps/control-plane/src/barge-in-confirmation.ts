import type { RealtimeTextDecisionRequest } from "./realtime-provider-command-port.js";

export const BARGE_IN_METADATA_PURPOSE = "barge_in_classifier_rebuild";

export type BargeInDecision = "INTERRUPT" | "IGNORE";

export function buildBargeInClassifierRequest(transcript: string, sourceItemId: string): RealtimeTextDecisionRequest {
  const safeTranscript = transcript.replace(/\s+/g, " ").trim().slice(0, 1200);
  return {
    purpose: BARGE_IN_METADATA_PURPOSE,
    metadata: {
      source_item_id: sourceItemId,
    },
    maxOutputTokens: 8,
    instructions:
      "Clasifica si esta transcripción representa a la persona llamante intentando interrumpir o dirigirse a la asistente mientras ella habla. " +
      "Responde exactamente INTERRUPT si es una pregunta, petición, corrección, confirmación, negación, petición de parar/esperar o frase claramente dirigida a la asistente. " +
      "Responde exactamente IGNORE si parece televisión, radio, eco, conversación de fondo, palabras sueltas, ruido transcrito, frase sin relación aparente o contenido no dirigido a la asistente. " +
      "Ante duda, responde IGNORE.",
    inputText: `Transcripción: ${JSON.stringify(safeTranscript)}`,
  };
}

export function parseBargeInDecision(text: unknown): BargeInDecision {
  if (typeof text !== "string") return "IGNORE";
  const normalized = text.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return normalized === "INTERRUPT" ? "INTERRUPT" : "IGNORE";
}
