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
      "Responde exactamente INTERRUPT si existe una interpretación razonable en la que sea una pregunta, petición, corrección, confirmación, negación, continuación, petición de parar/esperar o frase dirigida a la asistente. " +
      "Responde exactamente IGNORE_CONFIRMED solo si es inequívocamente televisión, radio, eco, conversación de fondo, ruido transcrito, palabras sin intención comunicativa o contenido claramente no dirigido a la asistente. " +
      "Una transcripción parcialmente degradada por habla solapada no es motivo suficiente para ignorar. Ante cualquier duda entre ambas opciones, responde INTERRUPT.",
    inputText: `Transcripción: ${JSON.stringify(safeTranscript)}`,
  };
}

/**
 * A usable completed transcript must not be destroyed by an ambiguous classifier
 * result. V40 may discard the caller item after IGNORE, so destructive IGNORE
 * requires an explicit positive certification from the classifier.
 *
 * Any malformed output, legacy plain IGNORE, timeout/fallback text or ambiguity
 * is therefore promoted to INTERRUPT and passed to the existing semantic pipeline.
 * Mutation safety remains downstream in the restaurant semantic/tool authorities.
 */
export function parseBargeInDecision(text: unknown): BargeInDecision {
  if (typeof text !== "string") return "INTERRUPT";
  const normalized = text.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return normalized === "IGNORECONFIRMED" ? "IGNORE" : "INTERRUPT";
}
