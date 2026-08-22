const MAX_TEXT_CHARS = 600;
const MAX_ARRAY_ITEMS = 12;
const MAX_OBJECT_KEYS = 32;
const MAX_DEPTH = 5;

const DROP_KEY_PARTS = [
  "secret",
  "token",
  "authorization",
  "api_key",
  "apikey",
  "password",
  "credential",
  "prompt",
  "instruction",
  "developer_message",
  "system_message",
  "audio",
];

const REDACT_VALUE_KEYS = new Set([
  "customer_name",
  "customer_phone",
  "caller_name",
  "caller_phone",
  "caller_number",
  "contact_name",
  "contact_phone",
  "destination_phone",
  "full_name",
  "phone",
  "email",
  "address",
  "date_of_birth",
  "notes",
  "reservation_code",
  "document_number",
]);

function normalizedKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
}

function redactionLabel(key: string): string {
  if (key.includes("phone") || key.includes("number")) return "[TELEFONO_REDACTADO]";
  if (key.includes("name")) return "[NOMBRE_REDACTADO]";
  if (key.includes("email")) return "[EMAIL_REDACTADO]";
  if (key.includes("reservation_code")) return "[CODIGO_REDACTADO]";
  return "[DATO_REDACTADO]";
}

/**
 * Best-effort minimisation for short-lived technical traces. The result is
 * still treated as personal data: this redactor complements access control and
 * retention; it is not an anonymisation boundary.
 */
export function redactTechnicalText(value: string): string {
  let text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";

  text = text
    .replace(/\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]){11,30}\b/gi, "[IBAN_REDACTADO]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[NUMERO_REDACTADO]")
    .replace(/\b(?:[XYZ]\s?[-.]?\s?\d{7,8}\s?[-.]?\s?[A-Z]|\d{8}\s?[-.]?\s?[A-Z])\b/gi, "[DOCUMENTO_REDACTADO]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTADO]")
    .replace(/(?<![\w:+-])(?:\+?\d[\d\s().-]{7,}\d)(?![\w:+-])/g, "[TELEFONO_REDACTADO]")
    .replace(/\bR[-\s]?\d{4,}\b/gi, "[CODIGO_REDACTADO]")
    .replace(
      /(c[oó]digo(?:\s+de\s+(?:la\s+)?reserva)?(?:\s+es|\s*:)?\s+)[A-Z0-9][A-Z0-9-]{4,}/giu,
      "$1[CODIGO_REDACTADO]",
    )
    .replace(
      /\b(me llamo|mi nombre es|reserva(?:r)?\s+a\s+nombre\s+de|a\s+nombre\s+de)\s+(?!(?:qui[eé]n|qu[eé])\b)[\p{L}'-]+(?:\s+[\p{L}'-]+){0,3}?(?=\s*(?:[,.;]|y\b|pero\b|ha\b|queda\b|qued[oó]\b|est[aá]\b|para\b|con\b|$))/giu,
      "$1 [NOMBRE_REDACTADO]",
    )
    .replace(
      /\b(direcci[oó]n(?:\s+es)?|vivo\s+en)\s+[^,.;]{2,100}/giu,
      "$1 [DIRECCION_REDACTADA]",
    )
    .replace(
      /\b(?:mi\s+)?(?:contrase[nñ]a|clave|pin|c[oó]digo\s+de\s+acceso)\s+(?:es\s+)?[^,.;]{1,100}/giu,
      "[CREDENCIAL_REDACTADA]",
    )
    .replace(
      /\b(?:tengo|tiene|con|por)\s+(?:una?\s+)?(?:discapacidad|alergia|intolerancia|enfermedad|deficiencia\s+auditiva|movilidad\s+reducida)[^,.;]{0,80}/giu,
      "[NECESIDAD_ESPECIAL_REDACTADA]",
    );

  return text.slice(0, MAX_TEXT_CHARS);
}

function tryParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  try { return JSON.parse(trimmed) as unknown; } catch { return null; }
}

function sanitizeValue(key: string, value: unknown, depth: number, seen: WeakSet<object>): unknown {
  const lower = normalizedKey(key);
  if (REDACT_VALUE_KEYS.has(lower)) return redactionLabel(lower);
  if (depth > MAX_DEPTH) return "[PROFUNDIDAD_LIMITADA]";

  if (typeof value === "string") {
    if (lower === "arguments" || lower === "output") {
      const parsed = tryParseJson(value);
      return parsed === null
        ? { unstructured_redacted: true, char_count: value.length }
        : sanitizeValue(lower, parsed, depth + 1, seen);
    }
    return redactTechnicalText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue("item", item, depth + 1, seen))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[REFERENCIA_CIRCULAR]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const nestedLower = normalizedKey(nestedKey);
      if (DROP_KEY_PARTS.some((part) => nestedLower.includes(part))) continue;
      const sanitized = sanitizeValue(nestedKey, nestedValue, depth + 1, seen);
      if (sanitized !== undefined) result[nestedKey] = sanitized;
    }
    seen.delete(value);
    return result;
  }
  return undefined;
}

export function sanitizeDiagnosticDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const sanitized: Record<string, unknown> = {};
  const seen = new WeakSet<object>();

  for (const [key, value] of Object.entries(details).slice(0, MAX_OBJECT_KEYS)) {
    const lower = normalizedKey(key);
    if (lower.includes("transcript")) {
      if (typeof value === "string") {
        sanitized.redacted_text = redactTechnicalText(value);
        sanitized.redaction_version = 2;
      } else if (typeof value === "boolean") {
        sanitized[key] = value;
      }
      continue;
    }
    if (DROP_KEY_PARTS.some((part) => lower.includes(part))) continue;
    const valueSanitized = sanitizeValue(key, value, 0, seen);
    if (valueSanitized !== undefined) sanitized[key] = valueSanitized;
  }
  return sanitized;
}
