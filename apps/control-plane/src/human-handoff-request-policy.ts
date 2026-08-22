function normalize(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
    : "";
}

const NEGATED_TRANSFER = /\b(?:no|nunca|tampoco|sin)\b.{0,40}\b(?:pas(?:a|ar|es|ame)|transf(?:erir|iere|iereme)|deriv(?:ar|ame)|comunic(?:ar|ame)|hablar)\b/;
const DIRECT_TRANSFER = /\b(?:pasame|pasa me|quiero que me pases|puedes pasarme|podrias pasarme|transfiereme|quiero que me transfieras|puedes transferirme|derivame|quiero que me derives|comunicame|quiero que me comuniques|ponme con)\b/;
const POLITE_TRANSFER_REQUEST = /\b(?:me\s+)?(?:puedes?|podrias?)\s+(?:pasar(?:me)?|transferir(?:me)?|derivar(?:me)?|comunicar(?:me)?)\b/;
const HUMAN_TARGET = /\b(?:persona|humano|recepcion|recepcionista|encargad[oa]|responsable|emplead[oa]|operador|agente|alguien|equipo)\b/;
const HUMAN_INTENT = /\b(?:quiero|quisiera|necesito|prefiero|deseo|puedo|podria|me gustaria)\b.{0,45}\b(?:hablar|contactar|comunicarme|pasar|transferir)\b|\b(?:hablar|contactar|comunicarme)\b.{0,35}\b(?:con)\b/;

/**
 * Deterministic authority guard for an irreversible transfer. Open-ended intent
 * remains model-owned; this policy only recognizes caller language that itself
 * explicitly requests a human transfer.
 */
export function isExplicitHumanHandoffRequest(transcript: unknown): boolean {
  const text = normalize(transcript);
  if (!text || NEGATED_TRANSFER.test(text)) return false;
  if (DIRECT_TRANSFER.test(text)) return true;
  if (POLITE_TRANSFER_REQUEST.test(text) && HUMAN_TARGET.test(text)) return true;
  return HUMAN_TARGET.test(text) && HUMAN_INTENT.test(text);
}
