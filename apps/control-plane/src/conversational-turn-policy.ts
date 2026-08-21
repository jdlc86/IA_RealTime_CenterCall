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
