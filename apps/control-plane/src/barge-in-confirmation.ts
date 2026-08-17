import { buildServerVad, type TenantVadSettings } from "./protected-turn-detection";

export const BARGE_IN_METADATA_PURPOSE = "barge_in_classifier_v36";

export type BargeInDecision = "INTERRUPT" | "IGNORE";

export function buildNonInterruptingListeningEvent(settings: TenantVadSettings = {}): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      audio: {
        input: {
          turn_detection: {
            ...buildServerVad(settings),
            create_response: false,
            interrupt_response: false,
          },
        },
      },
    },
  };
}

export function buildBargeInClassifierResponse(transcript: string, sourceItemId: string): Record<string, unknown> {
  const safeTranscript = transcript.replace(/\s+/g, " ").trim().slice(0, 1200);
  return {
    type: "response.create",
    response: {
      conversation: "none",
      output_modalities: ["text"],
      max_output_tokens: 8,
      tool_choice: "none",
      metadata: {
        purpose: BARGE_IN_METADATA_PURPOSE,
        source_item_id: sourceItemId,
      },
      instructions:
        "Clasifica si esta transcripción representa a la persona llamante intentando interrumpir o dirigirse a la asistente mientras ella habla. " +
        "Responde exactamente INTERRUPT si es una pregunta, petición, corrección, confirmación, negación, petición de parar/esperar o frase claramente dirigida a la asistente. " +
        "Responde exactamente IGNORE si parece televisión, radio, eco, conversación de fondo, palabras sueltas, ruido transcrito, frase sin relación aparente o contenido no dirigido a la asistente. " +
        "Ante duda, responde IGNORE.",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Transcripción: ${JSON.stringify(safeTranscript)}` }],
      }],
    },
  };
}

export function parseBargeInDecision(text: unknown): BargeInDecision {
  if (typeof text !== "string") return "IGNORE";
  const normalized = text.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return normalized === "INTERRUPT" ? "INTERRUPT" : "IGNORE";
}
