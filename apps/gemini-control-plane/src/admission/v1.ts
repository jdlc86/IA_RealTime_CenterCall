export const GEMINI_ADMISSION_VERSION_V1 = "gemini-admission.v1" as const;

export type GeminiAdmissionV1 = Readonly<{
  version: typeof GEMINI_ADMISSION_VERSION_V1;
  provider: "GEMINI";
  tenantId: string;
  callControlId: string;
  callSessionId: string;
  edgeSessionId: string;
  credentialId: string;
  notAfterEpochMs: number;
}>;

export type GeminiAdmissionValidationOptions = Readonly<{
  nowEpochMs: number;
  maxTtlMs: number;
}>;

const MAX_ID_CHARS = 256;

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > MAX_ID_CHARS || /[\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini admission must be an object");
  return value as Record<string, unknown>;
}

/**
 * Pure admission parser for the independent Gemini product. This establishes
 * the immutable identity that later binds Telnyx webhook admission, the
 * GeminiCallSession DO and the Media Edge credential. It performs no network,
 * database or provider work.
 */
export function parseGeminiAdmissionV1(
  value: unknown,
  options: GeminiAdmissionValidationOptions,
): GeminiAdmissionV1 {
  const source = asRecord(value);
  const nowEpochMs = positiveSafeInteger(options?.nowEpochMs, "Gemini admission nowEpochMs");
  const maxTtlMs = positiveSafeInteger(options?.maxTtlMs, "Gemini admission maxTtlMs");

  if (source.version !== GEMINI_ADMISSION_VERSION_V1) throw new Error("Unsupported Gemini admission version");
  if (source.provider !== "GEMINI") throw new Error("Gemini admission provider must be GEMINI");

  const notAfterEpochMs = positiveSafeInteger(source.notAfterEpochMs, "Gemini admission notAfterEpochMs");
  if (notAfterEpochMs <= nowEpochMs) throw new Error("Gemini admission is expired");
  if (notAfterEpochMs - nowEpochMs > maxTtlMs) throw new Error("Gemini admission TTL exceeds configured maximum");

  return Object.freeze({
    version: GEMINI_ADMISSION_VERSION_V1,
    provider: "GEMINI",
    tenantId: requiredId(source.tenantId, "Gemini admission tenantId"),
    callControlId: requiredId(source.callControlId, "Gemini admission callControlId"),
    callSessionId: requiredId(source.callSessionId, "Gemini admission callSessionId"),
    edgeSessionId: requiredId(source.edgeSessionId, "Gemini admission edgeSessionId"),
    credentialId: requiredId(source.credentialId, "Gemini admission credentialId"),
    notAfterEpochMs,
  });
}

export function assertGeminiAdmissionBindingV1(
  admission: GeminiAdmissionV1,
  expected: Readonly<{
    tenantId?: string;
    callControlId?: string;
    callSessionId?: string;
    edgeSessionId?: string;
    credentialId?: string;
  }>,
): void {
  const checks = [
    ["tenantId", expected.tenantId],
    ["callControlId", expected.callControlId],
    ["callSessionId", expected.callSessionId],
    ["edgeSessionId", expected.edgeSessionId],
    ["credentialId", expected.credentialId],
  ] as const;

  for (const [field, expectedValue] of checks) {
    if (expectedValue === undefined) continue;
    if (admission[field] !== expectedValue) throw new Error(`Gemini admission ${field} binding mismatch`);
  }
}
