const BOOKED_MARKER = "La reserva está confirmada por el backend.";
const MARKETING_RESULT_MARKER = "Responde de forma breve usando únicamente este resultado autorizado de preferencias comerciales:";
const TERMINAL_RESULT_MARKERS = [
  "Usa únicamente este resultado autorizado de cancelación:",
  "Indica que no has encontrado reservas futuras confirmadas asociadas al mismo número desde el que está llamando.",
  "Informa de las reservas futuras confirmadas asociadas a esta llamada usando únicamente estos resultados verificados:",
];

export const CONTINUATION_QUESTION = "¿Necesitas algo más en lo que pueda ayudarte?";
export const RESERVATION_AVAILABILITY_CHANGED_SPEECH =
  "Justo al confirmar, esa disponibilidad dejó de estar disponible y no se ha creado ninguna reserva. ¿Quieres que busque horarios cercanos para ese mismo día?";

const CONTINUATION_INSTRUCTION =
  ` Después de comunicar el resultado, pregunta exactamente: ${CONTINUATION_QUESTION} ` +
  "No dejes la llamada abierta en silencio. No esperes a que el usuario hable para devolverle el control de la conversación.";

const STRUCTURED_CONTINUATION_INSTRUCTIONS =
  `Comunica de forma breve y natural únicamente el resultado autorizado de la herramienta que acabas de recibir. ` +
  `Después pregunta exactamente: ${CONTINUATION_QUESTION} ` +
  "No añadas ninguna otra pregunta ni llames herramientas en esta respuesta.";

const AVAILABILITY_CHANGED_INSTRUCTIONS =
  `Pronuncia exactamente: ${JSON.stringify(RESERVATION_AVAILABILITY_CHANGED_SPEECH)} ` +
  "No llames herramientas en esta misma respuesta. Espera la respuesta del cliente. " +
  "Si después acepta buscar alternativas, usa restaurant_reservation_search en un turno posterior, limitado inicialmente a la misma fecha. " +
  "Cualquier alternativa elegida deberá pasar de nuevo por restaurant_reservation_create y por una confirmación explícita nueva.";

export type DirectPostToolResponseDecision =
  | {
      action: "GOVERN";
      reason:
        | "BOOKED"
        | "MARKETING_COMPLETED"
        | "RESERVATION_QUERY_COMPLETED"
        | "RESERVATION_CANCEL_COMPLETED"
        | "RESERVATION_MODIFY_COMPLETED"
        | "BUSINESS_INFO_COMPLETED";
      instructions: string;
    }
  | {
      action: "RECOVER";
      reason: "RESERVATION_AVAILABILITY_CHANGED";
      instructions: string;
      exactText: string;
    }
  | {
      action: "DEFAULT";
      reason: "MARKETING_CONSENT_PENDING" | "NON_TERMINAL" | "ERROR_OR_INVALID";
    };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] as string : "";
}

function governed(reason: Extract<DirectPostToolResponseDecision, { action: "GOVERN" }>["reason"]): DirectPostToolResponseDecision {
  return { action: "GOVERN", reason, instructions: STRUCTURED_CONTINUATION_INSTRUCTIONS };
}

/**
 * Structured post-tool policy for the direct-agent runtime.
 *
 * This is intentionally based on backend result fields instead of generated
 * speech text. Non-terminal states keep the model's normal tool workflow except
 * commit-time reservation conflicts: those yield one deterministic recovery
 * sentence and a caller choice before any alternative search. This prevents an
 * immediate MVCC read from racing a still-uncommitted winning transaction.
 */
export function decideDirectPostToolResponse(
  toolName: string,
  output: unknown,
): DirectPostToolResponseDecision {
  const payload = recordOf(output);
  if (!payload) return { action: "DEFAULT", reason: "ERROR_OR_INVALID" };

  const status = stringField(payload, "status");
  const stage = stringField(payload, "stage");

  if (
    toolName === "restaurant_reservation_create" &&
    (stage === "AVAILABILITY_CHANGED" || status === "AVAILABILITY_CHANGED") &&
    payload.reservation_created === false &&
    payload.requires_new_confirmation === true
  ) {
    return {
      action: "RECOVER",
      reason: "RESERVATION_AVAILABILITY_CHANGED",
      instructions: AVAILABILITY_CHANGED_INSTRUCTIONS,
      exactText: RESERVATION_AVAILABILITY_CHANGED_SPEECH,
    };
  }

  if (toolName === "restaurant_reservation_create" && stage === "BOOKED") {
    if (payload.ask_marketing_consent === true) {
      return { action: "DEFAULT", reason: "MARKETING_CONSENT_PENDING" };
    }
    return governed("BOOKED");
  }

  if (
    toolName === "restaurant_marketing_preferences" &&
    (status === "MARKETING_UPDATED" || status === "MARKETING_STATUS")
  ) {
    return governed("MARKETING_COMPLETED");
  }

  if (
    toolName === "restaurant_reservation_query" &&
    (status === "FOUND" || status === "NONE")
  ) {
    return governed("RESERVATION_QUERY_COMPLETED");
  }

  if (
    toolName === "restaurant_reservation_cancel" &&
    (status === "CANCELLED" || status === "NO_RESERVATIONS" || status === "PARTIAL_FAILURE")
  ) {
    return governed("RESERVATION_CANCEL_COMPLETED");
  }

  if (
    toolName === "restaurant_reservation_modify" &&
    (status === "MODIFIED" || status === "NO_RESERVATIONS")
  ) {
    return governed("RESERVATION_MODIFY_COMPLETED");
  }

  if (toolName === "restaurant_business_info" && status === "FOUND") {
    return governed("BUSINESS_INFO_COMPLETED");
  }

  if (payload.ok === false) return { action: "DEFAULT", reason: "ERROR_OR_INVALID" };
  return { action: "DEFAULT", reason: "NON_TERMINAL" };
}

export function applyTerminalConversationPolicy(instructions: string): string {
  if (instructions.includes(BOOKED_MARKER)) {
    return `${instructions}${CONTINUATION_INSTRUCTION} No anuncies que hablarás de ofertas o promociones más tarde.`;
  }

  if (instructions.includes(MARKETING_RESULT_MARKER)) {
    return `${instructions}${CONTINUATION_INSTRUCTION} No anuncies futuras ofertas o promociones.`;
  }

  if (TERMINAL_RESULT_MARKERS.some((marker) => instructions.includes(marker))) {
    return `${instructions}${CONTINUATION_INSTRUCTION}`;
  }

  return instructions;
}
