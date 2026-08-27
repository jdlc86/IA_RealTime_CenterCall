function normalize(value) {
  return typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
    : "";
}

function canonicalShortReply(value) {
  return normalize(value).replace(/[.,;:!?¿¡]+/g, " ").replace(/\s+/g, " ").trim();
}

export function initialFastHandoffAuthorizationState() {
  return Object.freeze({ offerPending: false });
}

export function isExplicitFastHandoffRejection(value) {
  const text = canonicalShortReply(value);
  return /^(?:(?:no)(?: no){0,5}|(?:no){2,6}|no gracias|mejor no|prefiero que no|dejalo|dejalo asi)$/.test(text);
}

function isAffirmative(value) {
  const text = canonicalShortReply(value);
  return /^(?:si(?: por favor)?|vale|de acuerdo|adelante|hazlo|perfecto|claro(?: que si)?|por supuesto)$/.test(text);
}

export function isExplicitFastHandoffRequest(value) {
  const text = normalize(value);
  if (!text) return false;
  return /\b(?:pasame|paseme|ponme|pongame|comunicame|comuniqueme|transfiereme|transfierame|quiero hablar|necesito hablar|puedo hablar|hablar con)\b[\s\S]{0,80}\b(?:persona|humano|humana|agente|recepcion|responsable|encargado|encargada|equipo)\b/.test(text)
    || /\b(?:persona|humano|humana|agente|recepcion|responsable|encargado|encargada)\b[\s\S]{0,60}\b(?:por favor|ahora|me atienda|me ayude)\b/.test(text);
}

/**
 * Port of the OpenAI human-handoff authority rule: the model may propose a
 * handoff, but an irreversible terminal transfer requires caller authority.
 */
export function authorizeFastHumanHandoff(state, currentTranscript) {
  const current = state && typeof state === "object" ? state : initialFastHandoffAuthorizationState();
  if (isExplicitFastHandoffRejection(currentTranscript)) {
    return Object.freeze({ allowed: false, source: "CALLER_REJECTED", state: Object.freeze({ offerPending: false }) });
  }
  if (isExplicitFastHandoffRequest(currentTranscript)) {
    return Object.freeze({ allowed: true, source: "EXPLICIT_REQUEST", state: Object.freeze({ offerPending: false }) });
  }
  if (current.offerPending === true && isAffirmative(currentTranscript)) {
    return Object.freeze({ allowed: true, source: "CONFIRMED_OFFER", state: Object.freeze({ offerPending: false }) });
  }
  return Object.freeze({ allowed: false, source: "OFFER_REQUIRED", state: Object.freeze({ offerPending: true }) });
}
