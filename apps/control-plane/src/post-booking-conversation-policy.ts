import { formatMadridReservationSpeech } from "./reservation-search-output-localization.js";
import type { RealtimeDeterministicContinuationContext } from "./realtime-deterministic-tool-continuation.js";

const BOOKED_MARKER = "La reserva está confirmada por el backend.";
const MARKETING_RESULT_MARKER = "Responde de forma breve usando únicamente este resultado autorizado de preferencias comerciales:";
const TERMINAL_RESULT_MARKERS = [
  "Usa únicamente este resultado autorizado de cancelación:",
  "Indica que no has encontrado reservas futuras confirmadas asociadas al mismo número desde el que está llamando.",
  "Informa de las reservas futuras confirmadas asociadas a esta llamada usando únicamente estos resultados verificados:",
];

export const CONTINUATION_QUESTION = "¿Necesitas algo más en lo que pueda ayudarte?";
export const RESERVATION_AVAILABILITY_CHANGED_SPEECH =
  "Perdona, pero lamentablemente, mientras confirmábamos, se ha registrado otra reserva y ese horario ha dejado de tener disponibilidad. No se ha creado ninguna reserva para ti. ¿Quieres que busque horarios cercanos para ese mismo día?";
export const RESERVATION_SLOT_UNAVAILABLE_SPEECH =
  "No tengo disponibilidad para ese horario. ¿Quieres que busque otros horarios ese mismo día?";

const CONTINUATION_INSTRUCTION =
  ` Después de comunicar el resultado, pregunta exactamente: ${CONTINUATION_QUESTION} ` +
  "No dejes la llamada abierta en silencio. No esperes a que el usuario hable para devolverle el control de la conversación.";

const STRUCTURED_CONTINUATION_INSTRUCTIONS =
  `Comunica de forma breve y natural únicamente el resultado autorizado de la herramienta que acabas de recibir. ` +
  `Después pregunta exactamente: ${CONTINUATION_QUESTION} ` +
  "No añadas ninguna otra pregunta ni llames herramientas en esta respuesta.";

const DUPLICATE_SEMANTIC_CONTINUATION_INSTRUCTIONS =
  "Continúa la conversación usando el resultado autorizado anterior de este mismo turno. " +
  "No describas el rechazo técnico ni menciones herramientas. No vuelvas a llamar ninguna herramienta en esta respuesta. " +
  "No afirmes que la acción se completó salvo que el resultado autorizado anterior confirme explícitamente su éxito. " +
  "Si ese resultado pedía confirmación, solicita de nuevo una confirmación breve y concreta; si pedía un dato, solicita solo ese dato; si era terminal, comunícalo brevemente. " +
  "Después espera un nuevo turno del cliente.";

const AVAILABILITY_CHANGED_INSTRUCTIONS =
  `Pronuncia exactamente: ${JSON.stringify(RESERVATION_AVAILABILITY_CHANGED_SPEECH)} ` +
  "No llames herramientas en esta misma respuesta. Espera la respuesta del cliente. " +
  "Si después acepta buscar alternativas, usa restaurant_reservation_search en un turno posterior, limitado inicialmente a la misma fecha. " +
  "Cualquier alternativa elegida deberá pasar de nuevo por restaurant_reservation_create y por una confirmación explícita nueva.";

export type ReservationCollectionSlot =
  | "starts_at_date"
  | "starts_at_time"
  | "party_size"
  | "customer_name"
  | "customer_phone"
  | "unknown";

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
      geminiDeterministic?: Readonly<{
        exactText: string;
        continuationContext: RealtimeDeterministicContinuationContext;
      }>;
    }
  | {
      action: "RECOVER";
      reason: "RESERVATION_AVAILABILITY_CHANGED" | "RESERVATION_SLOT_UNAVAILABLE";
      instructions: string;
      exactText: string;
    }
  | {
      action: "COLLECT";
      reason: "RESERVATION_MISSING_INFORMATION";
      missing: string[];
      collectSlot: ReservationCollectionSlot;
      instructions: string;
      exactText?: string;
      geminiDeterministic?: Readonly<{
        exactText: string;
        continuationContext: RealtimeDeterministicContinuationContext;
      }>;
    }
  | {
      action: "GEMINI_DETERMINISTIC";
      reason: "RESERVATION_AVAILABLE_NEEDS_CONTACT" | "RESERVATION_READY_TO_CONFIRM";
      exactText: string;
      continuationContext: RealtimeDeterministicContinuationContext;
      instructions: string;
    }
  | {
      action: "CONTINUE";
      reason: "DUPLICATE_SEMANTIC_DECISION";
      instructions: string;
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

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const raw = value[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function reservationSlotUnavailableSpeech(payload: Record<string, unknown>): string {
  const spokenDateTime = stringField(payload, "requested_starts_at_spoken");
  return spokenDateTime
    ? `No tengo disponibilidad para ${spokenDateTime}. ¿Quieres que busque otros horarios para esa fecha?`
    : RESERVATION_SLOT_UNAVAILABLE_SPEECH;
}

function slotUnavailableInstructions(exactText: string): string {
  return `Pronuncia exactamente: ${JSON.stringify(exactText)} ` +
    "La respuesta debe identificar explícitamente el día de la semana, la fecha y la hora cuando el backend los proporcione. " +
    "No llames herramientas en esta misma respuesta. Espera la respuesta del cliente. " +
    "Si después acepta buscar alternativas, usa restaurant_reservation_search en un turno posterior, limitado inicialmente a la misma fecha. " +
    "No anuncies una alternativa hasta que la búsqueda del backend la confirme.";
}

function governed(
  reason: Extract<DirectPostToolResponseDecision, { action: "GOVERN" }>["reason"],
): Extract<DirectPostToolResponseDecision, { action: "GOVERN" }> {
  return { action: "GOVERN", reason, instructions: STRUCTURED_CONTINUATION_INSTRUCTIONS };
}

export function nextReservationCollectionSlot(missing: readonly string[]): ReservationCollectionSlot {
  const unique = new Set(missing);
  if (unique.has("starts_at") || unique.has("starts_at_date")) return "starts_at_date";
  if (unique.has("starts_at_time")) return "starts_at_time";
  if (unique.has("party_size")) return "party_size";
  if (unique.has("customer_name")) return "customer_name";
  if (unique.has("customer_phone")) return "customer_phone";
  return "unknown";
}

function reservationMissingInformationSpeech(slot: ReservationCollectionSlot): string {
  if (slot === "starts_at_date") return "¿Para qué día quieres hacer la reserva?";
  if (slot === "starts_at_time") return "¿A qué hora quieres hacer la reserva?";
  if (slot === "party_size") return "¿Para cuántas personas sería la reserva?";
  if (slot === "customer_name") return "¿A qué nombre hago la reserva?";
  if (slot === "customer_phone") return "¿Cuál es el teléfono de contacto para la reserva?";
  return "Necesito un dato más para continuar con la reserva. ¿Puedes indicarme la información que falta?";
}

function continuationContextForSlot(slot: ReservationCollectionSlot): RealtimeDeterministicContinuationContext {
  if (slot === "starts_at_date") return "RESERVATION_STARTS_AT_DATE";
  if (slot === "starts_at_time") return "RESERVATION_STARTS_AT_TIME";
  if (slot === "party_size") return "RESERVATION_PARTY_SIZE";
  if (slot === "customer_name") return "RESERVATION_CUSTOMER_NAME";
  if (slot === "customer_phone") return "RESERVATION_CUSTOMER_PHONE";
  return "GENERAL";
}

function collectMissingInformation(missing: string[]): DirectPostToolResponseDecision {
  const collectSlot = nextReservationCollectionSlot(missing);
  const exactText = reservationMissingInformationSpeech(collectSlot);
  return {
    action: "COLLECT",
    reason: "RESERVATION_MISSING_INFORMATION",
    missing,
    collectSlot,
    exactText,
    geminiDeterministic: {
      exactText,
      continuationContext: continuationContextForSlot(collectSlot),
    },
    instructions:
      `Pronuncia exactamente: ${JSON.stringify(exactText)} ` +
      "Pregunta solo ese dato y ningún otro en esta respuesta. " +
      "No llames herramientas en esta misma respuesta. No intentes buscar disponibilidad ni crear otra reserva todavía. " +
      "Espera el siguiente turno del cliente; entonces conserva los datos válidos ya recogidos y continúa el flujo normal.",
  };
}

function clarifyUnprovenReservationTime(missing: string[]): DirectPostToolResponseDecision {
  return {
    action: "COLLECT",
    reason: "RESERVATION_MISSING_INFORMATION",
    missing,
    collectSlot: "starts_at_time",
    instructions:
      "Responde con naturalidad al significado del último turno. Explica brevemente que no has podido asociar con seguridad una hora concreta a la reserva y pide que la aclare. " +
      "No uses una frase fija ni repitas mecánicamente la pregunta anterior. No llames herramientas en esta respuesta y espera un nuevo turno del cliente.",
  };
}

function safeSpokenField(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function positivePartySize(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 100 ? Number(value) : null;
}

function readyToConfirmSpeech(payload: Record<string, unknown>): string | null {
  const reservation = recordOf(payload.reservation);
  if (!reservation) return null;
  const partySize = positivePartySize(reservation.party_size);
  const startsAt = safeSpokenField(reservation.starts_at, 80);
  const customerName = safeSpokenField(reservation.customer_name, 120);
  const spokenStartsAt = startsAt ? formatMadridReservationSpeech(startsAt) : null;
  if (!partySize || !spokenStartsAt || !customerName) return null;
  return `Tengo disponibilidad para ${partySize} personas el ${spokenStartsAt}, a nombre de ${customerName}. ¿Confirmas que haga la reserva?`;
}

function bookedSpeech(payload: Record<string, unknown>): string | null {
  const partySize = positivePartySize(payload.party_size);
  const startsAt = safeSpokenField(payload.starts_at, 80);
  const reservationCode = safeSpokenField(payload.reservation_code, 32);
  const spokenStartsAt = startsAt ? formatMadridReservationSpeech(startsAt) : null;
  if (!partySize || !spokenStartsAt || !reservationCode || !/^[A-Za-z0-9-]+$/.test(reservationCode)) return null;
  return `La reserva ha quedado confirmada para ${partySize} personas el ${spokenStartsAt}. Tu código de reserva es ${reservationCode}. ${CONTINUATION_QUESTION}`;
}

export function decideDirectPostToolResponse(
  toolName: string,
  output: unknown,
): DirectPostToolResponseDecision {
  const payload = recordOf(output);
  if (!payload) return { action: "DEFAULT", reason: "ERROR_OR_INVALID" };

  const status = stringField(payload, "status");
  const stage = stringField(payload, "stage");
  const reason = stringField(payload, "reason");

  if (status === "REJECTED" && reason === "DUPLICATE_SEMANTIC_DECISION") {
    return {
      action: "CONTINUE",
      reason: "DUPLICATE_SEMANTIC_DECISION",
      instructions: DUPLICATE_SEMANTIC_CONTINUATION_INSTRUCTIONS,
    };
  }

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

  if (
    toolName === "restaurant_reservation_create" &&
    status === "UNAVAILABLE_WITH_SEARCH_OPTION" &&
    payload.requested_available === false
  ) {
    const exactText = reservationSlotUnavailableSpeech(payload);
    return {
      action: "RECOVER",
      reason: "RESERVATION_SLOT_UNAVAILABLE",
      instructions: slotUnavailableInstructions(exactText),
      exactText,
    };
  }

  if (
    (toolName === "restaurant_reservation_create" || toolName === "restaurant_reservation_search") &&
    status === "MISSING_INFORMATION"
  ) {
    const missing = stringArrayField(payload, "missing");
    if (missing.length > 0) return collectMissingInformation(missing);
  }

  if (toolName === "restaurant_reservation_create" && status === "AVAILABLE_NEEDS_CONTACT") {
    const missing = stringArrayField(payload, "missing");
    const collectSlot = nextReservationCollectionSlot(missing);
    if (missing.length > 0 && (collectSlot === "customer_name" || collectSlot === "customer_phone")) {
      const exactText = reservationMissingInformationSpeech(collectSlot);
      return {
        action: "GEMINI_DETERMINISTIC",
        reason: "RESERVATION_AVAILABLE_NEEDS_CONTACT",
        exactText,
        continuationContext: continuationContextForSlot(collectSlot),
        instructions: `Pronuncia exactamente: ${JSON.stringify(exactText)} Espera el siguiente turno del cliente.`,
      };
    }
  }

  if (toolName === "restaurant_reservation_create" && (status === "READY_TO_CONFIRM" || status === "AVAILABLE_NEEDS_CONFIRMATION")) {
    const exactText = readyToConfirmSpeech(payload);
    if (exactText) {
      return {
        action: "GEMINI_DETERMINISTIC",
        reason: "RESERVATION_READY_TO_CONFIRM",
        exactText,
        continuationContext: "RESERVATION_CONFIRMATION",
        instructions: `Pronuncia exactamente: ${JSON.stringify(exactText)} Espera una confirmación explícita del cliente.`,
      };
    }
  }

  if (
    (toolName === "restaurant_reservation_create" || toolName === "restaurant_reservation_modify") &&
    status === "TIME_EVIDENCE_REQUIRED"
  ) {
    return clarifyUnprovenReservationTime(["starts_at_time"]);
  }

  if (toolName === "restaurant_reservation_create" && stage === "BOOKED") {
    if (payload.ask_marketing_consent === true) return { action: "DEFAULT", reason: "MARKETING_CONSENT_PENDING" };
    const decision = governed("BOOKED");
    const exactText = bookedSpeech(payload);
    return exactText
      ? { ...decision, geminiDeterministic: { exactText, continuationContext: "GENERAL" } }
      : decision;
  }

  if (toolName === "restaurant_marketing_preferences" && (status === "MARKETING_UPDATED" || status === "MARKETING_STATUS")) return governed("MARKETING_COMPLETED");
  if (toolName === "restaurant_reservation_query" && (status === "FOUND" || status === "NONE")) return governed("RESERVATION_QUERY_COMPLETED");
  if (toolName === "restaurant_reservation_cancel" && (status === "CANCELLED" || status === "NO_RESERVATIONS" || status === "PARTIAL_FAILURE")) return governed("RESERVATION_CANCEL_COMPLETED");
  if (toolName === "restaurant_reservation_modify" && (status === "MODIFIED" || status === "NO_RESERVATIONS")) return governed("RESERVATION_MODIFY_COMPLETED");
  if (toolName === "restaurant_business_info" && status === "FOUND") return governed("BUSINESS_INFO_COMPLETED");

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
