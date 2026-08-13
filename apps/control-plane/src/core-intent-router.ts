import type { BusinessInfoTopic, ClosingResponse, CoreIntentRequest } from "./core-intent-machine";

const CORE_INTENTS = new Set([
  "CREATE_RESERVATION",
  "CANCEL_RESERVATION",
  "QUERY_RESERVATION",
  "BUSINESS_INFO",
  "MARKETING_CONSENT",
  "OUT_OF_SCOPE",
  "CLOSING",
]);

const BUSINESS_TOPICS = new Set<BusinessInfoTopic>([
  "MENU",
  "HOURS",
  "LOCATION",
  "SERVICES",
  "GENERAL_INFO",
]);

const CLOSING_RESPONSES = new Set<ClosingResponse>(["CONFIRM", "REJECT"]);

function normalizeTopics(value: unknown): BusinessInfoTopic[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("Invalid business_info.topics");
  if (value.length === 0 || value.length > 5) throw new Error("Invalid business_info.topics");
  const topics: BusinessInfoTopic[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !BUSINESS_TOPICS.has(item as BusinessInfoTopic)) throw new Error("Invalid business_info.topics");
    if (!topics.includes(item as BusinessInfoTopic)) topics.push(item as BusinessInfoTopic);
  }
  return topics;
}

function normalizeClosingResponse(value: unknown): ClosingResponse | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !CLOSING_RESPONSES.has(value as ClosingResponse)) throw new Error("Invalid closing_response");
  return value as ClosingResponse;
}

export function parseCoreIntentRequest(argumentsJson: string | undefined): CoreIntentRequest {
  if (!argumentsJson?.trim()) throw new Error("Missing core intent payload");
  const parsed = JSON.parse(argumentsJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid core intent payload");
  const root = parsed as Record<string, unknown>;
  const intent = root.intent;
  if (typeof intent !== "string" || !CORE_INTENTS.has(intent)) throw new Error("Invalid core intent");
  const closingResponse = normalizeClosingResponse(root.closing_response);

  if (intent === "OUT_OF_SCOPE") {
    return { intent: "OUT_OF_SCOPE", ...(closingResponse ? { closingResponse } : {}) };
  }

  if (intent !== "BUSINESS_INFO") {
    return {
      intent: intent as CoreIntentRequest["intent"],
      ...(closingResponse ? { closingResponse } : {}),
    };
  }

  const businessInfo = root.business_info;
  if (!businessInfo || typeof businessInfo !== "object" || Array.isArray(businessInfo)) {
    // The only valid topic-less BUSINESS_INFO payload is the neutral carrier used
    // for a pure rejection of a pending close while the Core is in ROUTING.
    if (closingResponse === "REJECT") {
      return {
        intent: "BUSINESS_INFO",
        businessInfoTopics: ["GENERAL_INFO"],
        auxiliary: false,
        closingResponse,
      };
    }
    throw new Error("BUSINESS_INFO requires explicit topics");
  }
  const info = businessInfo as Record<string, unknown>;
  const topics = normalizeTopics(info.topics);
  if (!topics) throw new Error("BUSINESS_INFO requires explicit topics");
  return {
    intent: "BUSINESS_INFO",
    businessInfoTopics: topics,
    auxiliary: root.auxiliary === true,
    ...(closingResponse ? { closingResponse } : {}),
  };
}

/** Single classifier contract used by Realtime. */
export function coreIntentClassifierTool(currentMadridReference?: string): Record<string, unknown> {
  const temporalReference = currentMadridReference?.trim()
    ? ` Referencia temporal autoritativa actual en Europe/Madrid: ${currentMadridReference.trim()}. Usa esta referencia para resolver hoy/mañana; si fecha u hora siguen ambiguas, omite starts_at.`
    : "";
  return {
    type: "function",
    name: "conversation_intent",
    description: `Clasifica exclusivamente la intención ACTUAL del usuario. Elige exactamente una intención principal. REGLA DE DOMINIO: BUSINESS_INFO solo es válido cuando el turno pide información del restaurante/negocio actual. Debe poder señalarse qué dato del establecimiento se pide y por eso BUSINESS_INFO siempre debe incluir al menos un topic explícito: MENU, HOURS, LOCATION, SERVICES o GENERAL_INFO. GENERAL_INFO significa hechos del establecimiento actual, no conocimiento general. Si una pregunta puede responderse sin conocer este restaurante, o no existe una relación explícita/contextual clara con el establecimiento, clasifica OUT_OF_SCOPE. Ante duda entre BUSINESS_INFO y OUT_OF_SCOPE, elige OUT_OF_SCOPE. Ejemplos OUT_OF_SCOPE: "qué es un barco", "qué es un coche", "quién descubrió América", matemáticas, noticias o conocimiento general. Nunca uses una tool del negocio para intentar responder una pregunta fuera de dominio. Para CREATE_RESERVATION conserva en reservation solo los datos inequívocamente conocidos. Si el asistente acaba de presentar el resumen completo de reserva y pide confirmación explícita, una respuesta inequívoca como "sí", "confirmo" o "adelante" debe producir intent=CREATE_RESERVATION y reservation.confirm=true. No uses confirm=true fuera de ese contexto. BUSINESS_INFO puede contener varios topics y auxiliary=true solo cuando es una consulta del negocio temporal dentro de un workflow operativo que debe reanudarse. Si el turno responde directamente a una pregunta sobre terminar la llamada, incluye closing_response=CONFIRM o REJECT. Un rechazo puro del cierre conserva el workflow activo; solo si no había workflow usa BUSINESS_INFO sin business_info como carrier neutro con closing_response=REJECT. Nunca decidas estados backend como BOOKED o CANCELLED.${temporalReference}`,
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: ["CREATE_RESERVATION", "CANCEL_RESERVATION", "QUERY_RESERVATION", "BUSINESS_INFO", "MARKETING_CONSENT", "OUT_OF_SCOPE", "CLOSING"],
          description: "BUSINESS_INFO exige relación clara con el restaurante actual; ante duda usa OUT_OF_SCOPE.",
        },
        closing_response: {
          type: "string",
          enum: ["CONFIRM", "REJECT"],
          description: "Solo cuando el turno responde directamente a una pregunta previa sobre terminar la llamada.",
        },
        auxiliary: { type: "boolean", description: "Solo para BUSINESS_INFO temporal que debe volver al workflow operativo anterior." },
        business_info: {
          type: "object",
          description: "Obligatorio para BUSINESS_INFO salvo el carrier neutro de closing_response=REJECT. Los topics describen datos del restaurante actual, nunca conocimiento general.",
          properties: {
            topics: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              uniqueItems: true,
              items: { type: "string", enum: ["MENU", "HOURS", "LOCATION", "SERVICES", "GENERAL_INFO"] },
            },
          },
          required: ["topics"],
          additionalProperties: false,
        },
        reservation: {
          type: "object",
          description: "Para CREATE_RESERVATION o CANCEL_RESERVATION. Incluye solo datos inequívocamente conocidos; omite los desconocidos.",
          properties: {
            party_size: { type: "integer", minimum: 1, maximum: 100 },
            starts_at: { type: "string", description: "ISO 8601 con zona horaria; omite si sigue ambiguo." },
            customer_name: { type: "string" },
            customer_phone: { type: "string", description: "E.164 solo si el usuario proporciona explícitamente otro contacto." },
            use_caller_phone: { type: "boolean" },
            duration_minutes: { type: "integer", minimum: 15, maximum: 480 },
            notes: { type: "string" },
            selection_index: { type: "integer", minimum: 1, maximum: 20 },
            selection_indexes: { type: "array", items: { type: "integer", minimum: 1, maximum: 20 }, minItems: 1, maxItems: 20, uniqueItems: true },
            select_all: { type: "boolean" },
            confirm: { type: "boolean", description: "CREATE: true solo tras confirmar explícitamente el resumen completo del turno anterior. CANCEL: true solo tras confirmar explícitamente la cancelación presentada." },
          },
          additionalProperties: false,
        },
        marketing_consent: {
          type: "object",
          description: "Solo para MARKETING_CONSENT ante una decisión explícita del usuario.",
          properties: {
            action: { type: "string", enum: ["GRANT", "DECLINE", "REVOKE"] },
            explicit: { type: "boolean" },
            target_phone: { type: "string" },
          },
          required: ["action", "explicit"],
          additionalProperties: false,
        },
      },
      required: ["intent"],
      additionalProperties: false,
    },
  };
}
