export type TelnyxWebhookAdmissionIdentityInput = Readonly<{
  id?: unknown;
  occurred_at?: unknown;
}>;

export type TelnyxWebhookAdmissionIdentity = Readonly<{
  eventId: string;
  occurredAt: Date;
  credentialNotAfterEpochMs: number;
}>;

const GEMINI_MEDIA_EDGE_CREDENTIAL_TTL_MS = 10 * 60 * 1000;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

/**
 * Builds the retry-stable identity used by incoming-call admission. Both values
 * come from the signed Telnyx event body, unlike the delivery timestamp header,
 * which may change when Telnyx redelivers the same data.id.
 */
export function requireTelnyxWebhookAdmissionIdentity(
  input: TelnyxWebhookAdmissionIdentityInput,
): TelnyxWebhookAdmissionIdentity {
  const eventId = required(input.id, "Telnyx webhook event id");
  const occurredAtValue = required(input.occurred_at, "Telnyx webhook occurred_at");
  const occurredAtEpochMs = Date.parse(occurredAtValue);
  if (!Number.isSafeInteger(occurredAtEpochMs) || occurredAtEpochMs <= 0) {
    throw new Error("Telnyx webhook occurred_at is invalid");
  }
  const credentialNotAfterEpochMs = occurredAtEpochMs + GEMINI_MEDIA_EDGE_CREDENTIAL_TTL_MS;
  if (!Number.isSafeInteger(credentialNotAfterEpochMs)) {
    throw new Error("Telnyx webhook credential expiry is invalid");
  }
  return Object.freeze({
    eventId,
    occurredAt: new Date(occurredAtEpochMs),
    credentialNotAfterEpochMs,
  });
}
