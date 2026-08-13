import type { BusinessInfoTopic, CoreIntentRequest } from "./core-intent-machine";

const CORE_INTENTS = new Set([
  "CREATE_RESERVATION",
  "CANCEL_RESERVATION",
  "QUERY_RESERVATION",
  "BUSINESS_INFO",
  "MARKETING_CONSENT",
  "CLOSING",
]);

const BUSINESS_TOPICS = new Set<BusinessInfoTopic>([
  "MENU",
  "HOURS",
  "LOCATION",
  "SERVICES",
  "GENERAL_INFO",
]);

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

export function parseCoreIntentRequest(argumentsJson: string | undefined): CoreIntentRequest {
  if (!argumentsJson?.trim()) throw new Error("Missing core intent payload");
  const parsed = JSON.parse(argumentsJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid core intent payload");
  const root = parsed as Record<string, unknown>;
  const intent = root.intent;
  if (typeof intent !== "string" || !CORE_INTENTS.has(intent)) throw new Error("Invalid core intent");

  if (intent !== "BUSINESS_INFO") return { intent: intent as CoreIntentRequest["intent"] };

  const businessInfo = root.business_info;
  if (!businessInfo || typeof businessInfo !== "object" || Array.isArray(businessInfo)) {
    return { intent: "BUSINESS_INFO", businessInfoTopics: ["GENERAL_INFO"], auxiliary: root.auxiliary === true };
  }
  const info = businessInfo as Record<string, unknown>;
  return {
    intent: "BUSINESS_INFO",
    businessInfoTopics: normalizeTopics(info.topics) ?? ["GENERAL_INFO"],
    auxiliary: root.auxiliary === true,
  };
}

/** Single classifier contract used by Realtime. It decides routing and carries
 * the already-known domain payload in the same function call, avoiding a second
 * classifier/forced-tool response. Backend executors remain the source of truth. */
export function coreIntentClassifierTool(currentMadridReference?: string): Record<string, unknown> {
  const temporalReference = currentMadridReference?.trim()
    ? ` Referencia temporal autoritativa actual en Europe/Madrid: ${currentMadridReference.trim()}. Usa esta referencia para resolver hoy/mañana; si fecha u hora siguen ambiguas, omite starts_at.`
    : "";
  return {
    type: "function",
    name: "conversation_intent",
    description: `Clasifica la intención operativa ACTUAL del usuario y, en la MISMA llamada, incluye los datos inequívocamente conocidos del dominio. Elige exactamente una intención principal. BUSINESS_INFO puede contener varios topics (por ejemplo HOURS y MENU). Usa auxiliary=true solo cuando BUSINESS_INFO es una pregunta temporal dentro de un workflow operativo que debe reanudarse. Un cambio explícito entre reservar, cancelar o consultar cambia el workflow. Nunca decidas estados empresariales como BOOKED o CANCELLED: pertenecen exclusivamente al backend.${temporalReference}`,
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: ["CREATE_RESERVATION", "CANCEL_RESERVATION", "QUERY_RESERVATION", "BUSINESS_INFO", "MARKETING_CONSENT", "CLOSING"],
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
            confirm: { type: "boolean" },
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
