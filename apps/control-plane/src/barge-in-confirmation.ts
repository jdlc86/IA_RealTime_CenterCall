import type { RealtimeTextDecisionRequest } from "./realtime-provider-command-port.js";

export const BARGE_IN_METADATA_PURPOSE = "barge_in_classifier_rebuild";
export const BARGE_IN_IGNORE_VALIDATION_PURPOSE = "barge_in_ignore_validation_v40";

export type BargeInDecision = "INTERRUPT" | "IGNORE";
export type BargeInIgnoreValidation = "DIRECTED" | "BACKGROUND";

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

/**
 * A first-pass IGNORE is destructive if accepted: v40 may discard the caller
 * item and resume the assistant. A usable transcript therefore requires an
 * independent directedness check before IGNORE becomes authoritative.
 *
 * This validator is intentionally asymmetric:
 * - BACKGROUND must be explicit and confident;
 * - ambiguity/failure preserves the caller turn as DIRECTED.
 *
 * The semantic business pipeline remains the authority for what the caller
 * actually wants and can still classify the promoted turn as ignored input.
 */
export function buildBargeInIgnoreValidationRequest(
  transcript: string,
  sourceItemId: string,
): RealtimeTextDecisionRequest {
  const safeTranscript = transcript.replace(/\s+/g, " ").trim().slice(0, 1200);
  return {
    purpose: BARGE_IN_IGNORE_VALIDATION_PURPOSE,
    metadata: {
      source_item_id: sourceItemId,
    },
    maxOutputTokens: 8,
    instructions:
      "Segunda validación independiente para evitar perder una intervención real del llamante. " +
      "Responde exactamente DIRECTED si la transcripción puede ser razonablemente una pregunta, petición, corrección, respuesta, negación, continuación o frase dirigida a la asistente, aunque sea breve o esté parcialmente degradada por habla solapada. " +
      "Responde exactamente BACKGROUND solo si es claramente ruido, eco, televisión/radio, conversación ajena o contenido inequívocamente no dirigido a la asistente. " +
      "Si hay duda entre DIRECTED y BACKGROUND, responde DIRECTED.",
    inputText: `Transcripción: ${JSON.stringify(safeTranscript)}`,
  };
}

export function parseBargeInIgnoreValidation(text: unknown): BargeInIgnoreValidation {
  if (typeof text !== "string") return "DIRECTED";
  const normalized = text.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return normalized === "BACKGROUND" ? "BACKGROUND" : "DIRECTED";
}

export function resolveBargeInDecisionWithIgnoreValidation(
  primary: BargeInDecision,
  validation: BargeInIgnoreValidation,
): BargeInDecision {
  if (primary === "INTERRUPT") return "INTERRUPT";
  return validation === "BACKGROUND" ? "IGNORE" : "INTERRUPT";
}
