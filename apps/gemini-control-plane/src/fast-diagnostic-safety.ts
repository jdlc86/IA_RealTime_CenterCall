const SAFE_CODE_DETAIL_KEYS = new Set([
  "phase",
  "reason",
  "kind",
  "source",
  "authority",
  "effect",
  "capability",
  "type",
  "provider_error_code",
  "failure_category",
]);

const SAFE_NUMBER_DETAIL_KEYS = new Set([
  "rms",
  "noise_floor_rms",
  "effective_stop_rms",
  "close_code",
  "http_status",
  "observed_ms",
  "p50_ms",
  "p95_ms",
  "latency_sample_count",
  "provider_epoch",
  "post_tool_model_generations",
  "post_tool_discarded_model_output",
  "playback_authorities",
]);

const SAFE_BOOLEAN_DETAIL_KEYS = new Set([
  "authorized",
  "direct_model_output_allowed",
  "over_budget",
]);

function safeCode(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9_.:+-]+$/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function safeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

/**
 * Gemini-owned persistence boundary for diagnostic metadata. Unknown fields are
 * discarded and allowlisted fields have closed scalar types. Conversational
 * text, payloads, credentials, prompts and PII therefore cannot reach the
 * Supabase diagnostic sink through `details`.
 */
export function canonicalFastDiagnosticDetails(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("diagnostic details are invalid");
  const result: Record<string, string | number | boolean> = {};
  for (const [key, detail] of Object.entries(value as Record<string, unknown>)) {
    if (SAFE_CODE_DETAIL_KEYS.has(key)) {
      result[key] = safeCode(detail, `diagnostic detail ${key}`);
      continue;
    }
    if (SAFE_NUMBER_DETAIL_KEYS.has(key)) {
      result[key] = safeNumber(detail, `diagnostic detail ${key}`);
      continue;
    }
    if (SAFE_BOOLEAN_DETAIL_KEYS.has(key)) {
      if (typeof detail !== "boolean") throw new Error(`diagnostic detail ${key} is invalid`);
      result[key] = detail;
    }
  }
  return Object.freeze(result);
}
