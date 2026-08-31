export type GeminiAdmissionIdentityInput = Readonly<{
  tenantId: string;
  telnyxEventId: string;
  callControlId: string;
  secret: string;
}>;

export type GeminiAdmissionIdentity = Readonly<{
  callSessionId: string;
  edgeSessionId: string;
  credentialId: string;
}>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > 512 || /[\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function base64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacIdentity(
  key: CryptoKey,
  label: "call-session" | "edge-session" | "credential",
  canonicalIdentity: string,
): Promise<string> {
  const input = new TextEncoder().encode(`gemini-admission.v1|${label}|${canonicalIdentity}`);
  return base64Url(await crypto.subtle.sign("HMAC", key, input));
}

/**
 * Derives retry-stable, non-guessable logical identities from the signed Telnyx
 * event identity after tenant resolution. Domain-separated labels prevent one
 * identity type from being substituted for another. The secret is never stored
 * in the resulting admission or sent to the Media Edge.
 */
export async function issueGeminiAdmissionIdentity(
  input: GeminiAdmissionIdentityInput,
): Promise<GeminiAdmissionIdentity> {
  const tenantId = required(input.tenantId, "Gemini admission tenantId");
  const eventId = required(input.telnyxEventId, "Telnyx event id");
  const callControlId = required(input.callControlId, "Telnyx call_control_id");
  const secret = required(input.secret, "Gemini admission identity secret");
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("Gemini admission identity secret must be at least 32 bytes");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const canonical = `${tenantId.length}:${tenantId}|${eventId.length}:${eventId}|${callControlId.length}:${callControlId}`;
  const [callSession, edgeSession, credential] = await Promise.all([
    hmacIdentity(key, "call-session", canonical),
    hmacIdentity(key, "edge-session", canonical),
    hmacIdentity(key, "credential", canonical),
  ]);

  return Object.freeze({
    callSessionId: `cs_${callSession}`,
    edgeSessionId: `edge_${edgeSession}`,
    credentialId: `cred_${credential}`,
  });
}
