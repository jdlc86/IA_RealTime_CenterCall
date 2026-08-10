export type SemanticIntent = "CONTINUE" | "END_AMBIGUOUS" | "END_CLEAR";
export type DataRequirement = "NONE" | "BUSINESS_INFO" | "SERVICES" | "PROFESSIONALS" | "HOURS";

export type SemanticDecision = {
  intent: SemanticIntent;
  dataRequirement: DataRequirement;
  reason: string;
  degraded: boolean;
};

const INTENTS = new Set<SemanticIntent>(["CONTINUE", "END_AMBIGUOUS", "END_CLEAR"]);
const REQUIREMENTS = new Set<DataRequirement>(["NONE", "BUSINESS_INFO", "SERVICES", "PROFESSIONALS", "HOURS"]);

function safeReason(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : fallback;
}

/**
 * Parses the model's semantic-routing tool arguments without ever leaving the
 * call without a deterministic next action.
 *
 * Fail-safe policy:
 * - malformed/unknown intent => CONTINUE + BUSINESS_INFO (grounded, fail-closed)
 * - valid CONTINUE + missing/unknown data requirement => BUSINESS_INFO
 * - any end intent => data requirement is forced to NONE
 */
export function parseSemanticDecision(argumentsJson: string | undefined): SemanticDecision {
  if (!argumentsJson?.trim()) {
    return {
      intent: "CONTINUE",
      dataRequirement: "BUSINESS_INFO",
      reason: "classifier_empty_output_fallback",
      degraded: true,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not_object");
    parsed = value as Record<string, unknown>;
  } catch {
    return {
      intent: "CONTINUE",
      dataRequirement: "BUSINESS_INFO",
      reason: "classifier_invalid_json_fallback",
      degraded: true,
    };
  }

  const rawIntent = parsed.intent;
  const intent: SemanticIntent =
    typeof rawIntent === "string" && INTENTS.has(rawIntent as SemanticIntent)
      ? (rawIntent as SemanticIntent)
      : "CONTINUE";

  if (intent !== "CONTINUE") {
    return {
      intent,
      dataRequirement: "NONE",
      reason: safeReason(parsed.reason, "semantic_end_classifier"),
      degraded: !(typeof rawIntent === "string" && INTENTS.has(rawIntent as SemanticIntent)),
    };
  }

  const rawRequirement = parsed.data_requirement ?? parsed.dataRequirement;
  const requirement: DataRequirement =
    typeof rawRequirement === "string" && REQUIREMENTS.has(rawRequirement as DataRequirement)
      ? (rawRequirement as DataRequirement)
      : "BUSINESS_INFO";

  const degraded =
    !(typeof rawIntent === "string" && INTENTS.has(rawIntent as SemanticIntent)) ||
    !(typeof rawRequirement === "string" && REQUIREMENTS.has(rawRequirement as DataRequirement));

  return {
    intent,
    dataRequirement: requirement,
    reason: safeReason(parsed.reason, degraded ? "classifier_partial_output_fallback" : "semantic_intent_classifier"),
    degraded,
  };
}
