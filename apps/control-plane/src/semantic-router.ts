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

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function inferRequirementFromText(value: string): DataRequirement | null {
  const text = normalize(value);
  if (/\b(tratamiento|tratamientos|servicio|servicios|procedimiento|procedimientos|terapia|terapias|catalogo|precio|precios|coste|costes|cuesta|cuestan|duracion|botox|ofrece|ofrecen|ofreceis|disponible|disponibles)\b/.test(text)) return "SERVICES";
  if (/\b(profesional|profesionales|especialista|especialistas|medico|medicos|personal)\b/.test(text)) return "PROFESSIONALS";
  if (/\b(horario|horarios|apertura|cierre|abre|abren|cierra|cierran)\b/.test(text)) return "HOURS";
  return null;
}

function recoverRequirementFromReason(reason: string): DataRequirement | null {
  return inferRequirementFromText(reason);
}

export function parseSemanticDecision(argumentsJson: string | undefined): SemanticDecision {
  if (!argumentsJson?.trim()) return { intent: "CONTINUE", dataRequirement: "BUSINESS_INFO", reason: "classifier_empty_output_fallback", degraded: true };

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not_object");
    parsed = value as Record<string, unknown>;
  } catch {
    return { intent: "CONTINUE", dataRequirement: "BUSINESS_INFO", reason: "classifier_invalid_json_fallback", degraded: true };
  }

  const rawIntent = parsed.intent;
  const intent: SemanticIntent = typeof rawIntent === "string" && INTENTS.has(rawIntent as SemanticIntent) ? (rawIntent as SemanticIntent) : "CONTINUE";

  if (intent !== "CONTINUE") {
    return {
      intent,
      dataRequirement: "NONE",
      reason: safeReason(parsed.reason, "semantic_end_classifier"),
      degraded: !(typeof rawIntent === "string" && INTENTS.has(rawIntent as SemanticIntent)),
    };
  }

  const rawRequirement = parsed.data_requirement ?? parsed.dataRequirement;
  let requirement: DataRequirement = typeof rawRequirement === "string" && REQUIREMENTS.has(rawRequirement as DataRequirement) ? (rawRequirement as DataRequirement) : "BUSINESS_INFO";
  let degraded = !(typeof rawIntent === "string" && INTENTS.has(rawIntent as SemanticIntent)) || !(typeof rawRequirement === "string" && REQUIREMENTS.has(rawRequirement as DataRequirement));
  const reason = safeReason(parsed.reason, degraded ? "classifier_partial_output_fallback" : "semantic_intent_classifier");

  // If the classifier describes a concrete external domain but returns a generic
  // NONE/BUSINESS_INFO requirement, prefer the domain evidence and fail closed.
  if (requirement === "NONE" || requirement === "BUSINESS_INFO") {
    const recovered = recoverRequirementFromReason(reason);
    if (recovered) {
      requirement = recovered;
      degraded = true;
    }
  }

  return { intent, dataRequirement: requirement, reason, degraded };
}
