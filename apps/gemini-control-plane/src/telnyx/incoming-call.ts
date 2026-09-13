export type VerifiedTelnyxIncomingCall = Readonly<{
  eventId: string;
  occurredAt: string;
  occurredAtEpochMs: number;
  callControlId: string;
  telnyxCallSessionId: string | null;
  calledNumber: string;
  callerNumber: string | null;
}>;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > 512 || /[\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, field);
}

/**
 * Parses ONLY a raw body that has already passed Telnyx signature verification.
 * This function intentionally does not perform tenant lookup, provider
 * selection or call admission. It extracts immutable signed transport identity.
 */
export function parseVerifiedTelnyxIncomingCall(rawBody: string): VerifiedTelnyxIncomingCall {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); }
  catch { throw new Error("Verified Telnyx webhook body is not valid JSON"); }

  const root = record(parsed, "Telnyx webhook");
  const data = record(root.data, "Telnyx webhook data");
  if (data.event_type !== "call.initiated") throw new Error("Telnyx webhook is not call.initiated");
  const payload = record(data.payload, "Telnyx webhook payload");
  if (payload.direction !== "incoming") throw new Error("Telnyx call is not incoming");

  const eventId = requiredString(data.id, "Telnyx event id");
  const occurredAt = requiredString(data.occurred_at, "Telnyx occurred_at");
  const occurredAtEpochMs = Date.parse(occurredAt);
  if (!Number.isSafeInteger(occurredAtEpochMs) || occurredAtEpochMs <= 0) {
    throw new Error("Telnyx occurred_at is invalid");
  }

  return Object.freeze({
    eventId,
    occurredAt: new Date(occurredAtEpochMs).toISOString(),
    occurredAtEpochMs,
    callControlId: requiredString(payload.call_control_id, "Telnyx call_control_id"),
    telnyxCallSessionId: optionalString(payload.call_session_id, "Telnyx call_session_id"),
    calledNumber: requiredString(payload.to, "Telnyx called number"),
    callerNumber: optionalString(payload.from, "Telnyx caller number"),
  });
}
