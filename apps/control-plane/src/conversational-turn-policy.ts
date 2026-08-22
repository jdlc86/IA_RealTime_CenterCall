function normalizeConversationalTurn(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PURE_GREETING_PATTERNS = new Set([
  "hola",
  "buenas",
  "muy buenas",
  "buenos dias",
  "buenas tardes",
  "buenas noches",
  "hola buenas",
  "hola buenos dias",
  "hola buenas tardes",
  "hola buenas noches",
  "hey",
  "ey",
]);

const PRESENCE_ACKNOWLEDGEMENT_PATTERNS = new Set([
  "si",
  "si sigo aqui",
  "sigo aqui",
  "aqui sigo",
  "si estoy aqui",
  "estoy aqui",
  "aqui estoy",
  "si aqui estoy",
  "si te escucho",
  "te escucho",
  "si dime",
  "dime",
]);

/**
 * A greeting with no business request is conversational evidence, not permission
 * to read or mutate backend data. Compound turns remain model-owned.
 */
export function isPureGreetingTurn(value: string): boolean {
  const normalized = normalizeConversationalTurn(value);
  if (PURE_GREETING_PATTERNS.has(normalized)) return true;
  if (normalized.endsWith(" lucia")) {
    return PURE_GREETING_PATTERNS.has(normalized.slice(0, -" lucia".length).trim());
  }
  return false;
}

/**
 * Presence acknowledgements are meaningful only while the lifecycle is waiting
 * for the answer to its own presence check. Keep this matcher deliberately
 * narrow so compound business turns remain model-owned.
 */
export function isPresenceAcknowledgementTurn(value: string): boolean {
  return PRESENCE_ACKNOWLEDGEMENT_PATTERNS.has(normalizeConversationalTurn(value));
}
