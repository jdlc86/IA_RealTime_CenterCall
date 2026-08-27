import { createHmac, timingSafeEqual } from "node:crypto";

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function nullableE164(value, field) {
  if (value === null) return null;
  const normalized = required(value, field);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error(`${field} must be E.164`);
  return normalized;
}

function e164(value, field) {
  const normalized = nullableE164(value, field);
  if (normalized === null) throw new Error(`${field} is required`);
  return normalized;
}

function securityVersion(value) {
  if (value !== 1) throw new Error("Gemini media edge credential security version is invalid");
  return 1;
}

function safeEpoch(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function base64urlDecode(value, field) {
  const normalized = required(value, field);
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) throw new Error(`${field} is invalid`);
  try { return Buffer.from(normalized, "base64url"); }
  catch { throw new Error(`${field} is invalid`); }
}

function secureEdgeUrl(value) {
  const normalized = required(value, "Gemini media edge credential edge URL");
  let parsed;
  try { parsed = new URL(normalized); }
  catch { throw new Error("Gemini media edge credential edge URL is invalid"); }
  if (parsed.protocol !== "wss:") throw new Error("Gemini media edge credential edge URL must use wss://");
  if (parsed.username || parsed.password) throw new Error("Gemini media edge credential edge URL must not contain credentials");
  return parsed.toString();
}

function targetLegs(value) {
  if (!(["self", "opposite", "both"]).includes(value)) throw new Error("Gemini media edge credential target legs are invalid");
  return value;
}

function canonicalClaims(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini media edge credential claims are invalid");
  if (value.provider !== "GEMINI") throw new Error("Gemini media edge credential provider must be GEMINI");
  const credentialId = required(value.credentialId, "Gemini media edge credential id");
  if (credentialId.length > 256) throw new Error("Gemini media edge credential id exceeds 256 characters");
  return Object.freeze({
    credentialId,
    provider: "GEMINI",
    tenantId: required(value.tenantId, "Gemini media edge credential tenant_id"),
    callControlId: required(value.callControlId, "Gemini media edge credential call_control_id"),
    sessionId: required(value.sessionId, "Gemini media edge credential session_id"),
    routeId: required(value.routeId, "Gemini media edge credential route_id"),
    callerPhoneE164: nullableE164(value.callerPhoneE164, "Gemini media edge credential caller phone"),
    calledPhoneE164: e164(value.calledPhoneE164, "Gemini media edge credential called phone"),
    securityVersion: securityVersion(value.securityVersion),
    edgeUrl: secureEdgeUrl(value.edgeUrl),
    targetLegs: targetLegs(value.targetLegs),
    notAfterEpochMs: safeEpoch(value.notAfterEpochMs, "Gemini media edge credential notAfterEpochMs"),
  });
}

function parseSignedCredential(rawCredential) {
  const token = required(rawCredential, "Gemini media edge credential");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Gemini media edge credential format is invalid");
  const payloadBytes = base64urlDecode(parts[1], "Gemini media edge credential payload");
  const signatureBytes = base64urlDecode(parts[2], "Gemini media edge credential signature");
  let claims;
  try { claims = JSON.parse(payloadBytes.toString("utf8")); }
  catch { throw new Error("Gemini media edge credential claims are invalid"); }
  return { token, signingInput: `${parts[0]}.${parts[1]}`, signatureBytes, claims: canonicalClaims(claims) };
}

export function createHmacCredentialVerifier(secret, expectedEdgeUrl) {
  const key = required(secret, "MEDIA_EDGE_CREDENTIAL_HMAC_SECRET");
  if (Buffer.byteLength(key, "utf8") < 32) throw new Error("MEDIA_EDGE_CREDENTIAL_HMAC_SECRET must be at least 32 bytes");
  const expectedUrl = secureEdgeUrl(expectedEdgeUrl);

  return async function verify(rawCredential, nowEpochMs = Date.now()) {
    const now = safeEpoch(nowEpochMs, "Gemini media edge nowEpochMs");
    const parsed = parseSignedCredential(rawCredential);
    const expectedSignature = createHmac("sha256", key).update(parsed.signingInput, "utf8").digest();
    if (parsed.signatureBytes.length !== expectedSignature.length || !timingSafeEqual(parsed.signatureBytes, expectedSignature)) {
      throw new Error("Gemini media edge credential verification failed");
    }
    if (now >= parsed.claims.notAfterEpochMs) throw new Error("Gemini media edge credential expired");
    if (parsed.claims.edgeUrl !== expectedUrl) throw new Error("Gemini media edge credential was issued for a different edge URL");
    return parsed.claims;
  };
}

export function signHmacCredentialForTest(claims, secret) {
  const canonical = canonicalClaims(claims);
  const key = required(secret, "credential signing secret");
  const payload = Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url");
  const signingInput = `v1.${payload}`;
  const signature = createHmac("sha256", key).update(signingInput, "utf8").digest("base64url");
  return `${signingInput}.${signature}`;
}

export class InMemoryOneShotCredentialConsumer {
  constructor() { this.consumed = new Map(); }

  consume(credentialId, notAfterEpochMs, nowEpochMs = Date.now()) {
    const id = required(credentialId, "Gemini media edge credential id");
    const expiry = safeEpoch(notAfterEpochMs, "Gemini media edge credential notAfterEpochMs");
    const now = safeEpoch(nowEpochMs, "Gemini media edge consume nowEpochMs");
    if (now >= expiry) throw new Error("Gemini media edge credential expired");
    for (const [existingId, existingExpiry] of this.consumed) {
      if (now >= existingExpiry) this.consumed.delete(existingId);
    }
    if (this.consumed.has(id)) return false;
    this.consumed.set(id, expiry);
    return true;
  }

  size() { return this.consumed.size; }
}

export function requireTelnyxStartForCredential(claims, message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.event !== "start") {
    throw new Error("Gemini media edge requires Telnyx start as the identity frame");
  }
  const streamId = required(message.stream_id, "Telnyx media stream_id");
  const callControlId = required(message.start?.call_control_id, "Telnyx media start call_control_id");
  if (callControlId !== claims.callControlId) {
    throw new Error("Telnyx media start call_control_id does not match the authorized Gemini edge session");
  }
  const format = message.start?.media_format;
  if (format?.encoding !== "L16" || format.sample_rate !== 16000 || format.channels !== 1) {
    throw new Error("Telnyx Gemini media requires mono L16 at 16000 Hz");
  }
  return Object.freeze({ streamId, callControlId });
}
