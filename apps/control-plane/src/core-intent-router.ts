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
  if (value.length === 0 || value.length > 8) throw new Error("Invalid business_info.topics");
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
    return {
      intent: "BUSINESS_INFO",
      businessInfoTopics: ["GENERAL_INFO"],
      auxiliary: root.auxiliary === true,
      ...(closingResponse ? { closingResponse } : {}),
    };
  }
  const info = businessInfo as Record<string, unknown>;
  return {
    intent: "BUSINESS_INFO",
    businessInfoTopics: normalizeTopics(info.topics) ?? ["GENERAL_INFO"],
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
    description: `Clasifica la intención operativa ACTUAL del usuario y, en la MISMA llamada, incluye los datos inequívocamente conocidos del dominio. Elige exactamente una intención principal. Este asistente atiende exclusivamente asuntos del negocio actual. Usa BUSINESS_INFO solo cuando la pregunta se refiere explícita o contextualmente al negocio, por ejemplo carta, horarios, ubicación, servicios o información general del establecimiento. Si la pregunta es conocimiento general o no guarda relación con el negocio, como "qué es un barco", "quién descubrió América" o equivalente, usa OUT_OF_SCOPE. Nunca conviertas una pregunta fuera de dominio en BUSINESS_INFO y no intentes responderla con conocimiento general. Para CREATE_RESERVATION conserva en reservation todos los datos inequívocamente conocidos de la reserva. Si el asistente acaba de presentar un resumen completo de reserva y pide confirmación explícita, una respuesta inequívoca del usuario como "sí", "confirmo", "adelante" o equivalente debe producir intent=CREATE_RESERVATION y reservation.confirm=true. No uses confirm=true para aceptación de promociones, respuestas vagas ni antes de un resumen de reserva. BUSINESS_INFO puede contener varios topics. Usa auxiliary=true solo cuando BUSINESS_INFO es una pregunta temporal dentro de un workflow operativo que debe reanudarse. Si el turno responde directamente a la pregunta del asistente sobre terminar la llamada, incluye closing_response=CONFIRM si acepta terminar o closing_response=REJECT si rechaza terminar. Un rechazo puro del cierre no es una nueva intención empresarial: conserva como intent el workflow operativo que estaba activo; si no había uno, usa BUSINESS_INFO con GENERAL_INFO solo como valor neutro y closing_response=REJECT. Si el usuario rechaza cerrar y además expresa una nueva intención, incluye closing_response=REJECT junto con esa nueva intención. Nunca decidas estados empresariales como BOOKED o CANCELLED: pertenecen exclusivamente al backend.${temporalReference}`,
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: ["CREATE_RESERVATION", "CANCEL_RESERVATION", "QUERY_RESERVATION", "BUSINESS_INFO", "MARKETING_CONSENT", "OUT_OF_SCOPE", "CLOSING"],
        },
        closing_response: {
          type: "string",
          enum: ["CONFIRM", "REJECT"],
          description: "Solo cuando el turno responde directamente a una pregunta previa del asistente sobre terminar la llamada.",
        },
        auxiliary: { type: "boolean", description: "Solo para BUSINESS_INFO temporal que debe volver al workflow operativo anterior." },
        business_info: {
          type: "object",
          properties: {
            topics: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              uniqueItems: true,
              items: { type: "string", enum: ["MENU", "HOURS", "LOCATION", "SERVICES", "GENERAL_INFO"] },
            },
          },
          additionalProperties: false,
        },
        reservation: {
          type: "object",
          description: "Para CREATE_RESERVATION o CANCEL_RESERVATION. Incluye solo datos inequívocamente conocidos; omite los desconocidos. En CREATE_RESERVATION, si el turno actual confirma explícitamente el resumen completo de reserva presentado inmediatamente antes por el asistente, incluye confirm=true.",
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
            confirm: { type: "boolean", description: "CREATE: true solo si el usuario acaba de confirmar explícitamente el resumen completo de reserva presentado por el asistente en el turno anterior. CANCEL: true solo si confirma explícitamente la cancelación presentada." },
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
