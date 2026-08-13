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
    if (typeof item !== "string" || !BUSINESS_TOPICS.has(item as BusinessInfoTopic)) {
      throw new Error("Invalid business_info.topics");
    }
    if (!topics.includes(item as BusinessInfoTopic)) topics.push(item as BusinessInfoTopic);
  }
  return topics;
}

/**
 * Parses the new top-level classifier contract. The classifier decides current
 * user intent only; business truth (BOOKED/CANCELLED/etc.) is never accepted here.
 */
export function parseCoreIntentRequest(argumentsJson: string | undefined): CoreIntentRequest {
  if (!argumentsJson?.trim()) throw new Error("Missing core intent payload");
  const parsed = JSON.parse(argumentsJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid core intent payload");
  const root = parsed as Record<string, unknown>;
  const intent = root.intent;
  if (typeof intent !== "string" || !CORE_INTENTS.has(intent)) throw new Error("Invalid core intent");

  if (intent !== "BUSINESS_INFO") {
    return { intent: intent as CoreIntentRequest["intent"] };
  }

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

export function coreIntentClassifierTool(): Record<string, unknown> {
  return {
    type: "function",
    name: "conversation_intent_v2",
    description: "Clasifica la intención operativa ACTUAL del usuario. Elige exactamente una intención principal. BUSINESS_INFO puede contener varios topics en el mismo turno (por ejemplo HOURS y MENU). Usa auxiliary=true cuando BUSINESS_INFO es una pregunta temporal dentro de un workflow operativo que debe reanudarse después. Un cambio explícito de reservar a cancelar/consultar, o viceversa, NO es auxiliar: cambia el workflow. Nunca decidas ni inventes estados empresariales como BOOKED o CANCELLED; esos estados pertenecen exclusivamente al backend.",
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: ["CREATE_RESERVATION", "CANCEL_RESERVATION", "QUERY_RESERVATION", "BUSINESS_INFO", "MARKETING_CONSENT", "CLOSING"],
        },
        auxiliary: {
          type: "boolean",
          description: "Solo true para una consulta BUSINESS_INFO temporal que debe volver al workflow operativo anterior.",
        },
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
      },
      required: ["intent"],
      additionalProperties: false,
    },
  };
}
