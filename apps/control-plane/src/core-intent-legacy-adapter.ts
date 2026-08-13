import { parseCoreIntentRequest } from "./core-intent-router";

export type LegacyIntentEventPayload = Record<string, unknown>;

function requireRoot(argumentsJson: string | undefined): Record<string, unknown> {
  if (!argumentsJson?.trim()) throw new Error("Missing core intent payload");
  const parsed = JSON.parse(argumentsJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid core intent payload");
  return parsed as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid domain payload");
  return value as Record<string, unknown>;
}

/**
 * Transitional compatibility adapter. Realtime has one hierarchical classifier,
 * while the already validated CREATE/CANCEL/QUERY/marketing executors continue to
 * consume their legacy payload shape. This function does not execute business
 * logic and does not infer missing data.
 */
export function adaptHierarchicalIntentToLegacy(argumentsJson: string | undefined): LegacyIntentEventPayload | null {
  const request = parseCoreIntentRequest(argumentsJson);
  const root = requireRoot(argumentsJson);

  if (request.intent === "BUSINESS_INFO") return null;
  if (request.intent === "CLOSING") {
    return { intent: "END_CLEAR", data_requirement: "NONE", reason: "core_intent_closing" };
  }

  if (request.intent === "MARKETING_CONSENT") {
    return {
      intent: "CONTINUE",
      data_requirement: "MARKETING_CONSENT",
      reason: "core_intent_marketing_consent",
      ...(root.marketing_consent !== undefined ? { marketing_consent: optionalObject(root.marketing_consent) } : {}),
    };
  }

  const operation = request.intent === "CREATE_RESERVATION"
    ? "CREATE"
    : request.intent === "CANCEL_RESERVATION"
      ? "CANCEL"
      : "QUERY";
  const reservation = optionalObject(root.reservation) ?? {};
  return {
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: `core_intent_${operation.toLowerCase()}`,
    reservation: { ...reservation, operation },
  };
}
