export const GEMINI_CONTROL_CAPABILITY_VERSION_V1 = "gemini-control-capability.v1" as const;

export type GeminiControlCapabilityClaimsV1 = Readonly<{
  version: typeof GEMINI_CONTROL_CAPABILITY_VERSION_V1;
  provider: "GEMINI";
  tenantId: string;
  callControlId: string;
  callSessionId: string;
  edgeSessionId: string;
  credentialId: string;
  notAfterEpochMs: number;
}>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > 256 || /[\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try { binary = atob(padded); }
  catch { throw new Error("Gemini control capability encoding is invalid"); }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function canonicalClaims(value: unknown): GeminiControlCapabilityClaimsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini control capability claims are invalid");
  const source = value as Record<string, unknown>;
  if (source.version !== GEMINI_CONTROL_CAPABILITY_VERSION_V1) throw new Error("Gemini control capability version is invalid");
  if (source.provider !== "GEMINI") throw new Error("Gemini control capability provider is invalid");
  return Object.freeze({
    version: GEMINI_CONTROL_CAPABILITY_VERSION_V1,
    provider: "GEMINI",
    tenantId: required(source.tenantId, "Gemini control capability tenantId"),
    callControlId: required(source.callControlId, "Gemini control capability callControlId"),
    callSessionId: required(source.callSessionId, "Gemini control capability callSessionId"),
    edgeSessionId: required(source.edgeSessionId, "Gemini control capability edgeSessionId"),
    credentialId: required(source.credentialId, "Gemini control capability credentialId"),
    notAfterEpochMs: positiveSafeInteger(source.notAfterEpochMs, "Gemini control capability notAfterEpochMs"),
  });
}

async function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const normalized = required(secret, "Gemini control capability secret");
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.byteLength < 32) throw new Error("Gemini control capability secret must be at least 32 bytes");
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

export async function issueGeminiControlCapabilityV1(
  claims: GeminiControlCapabilityClaimsV1,
  signingSecret: string,
): Promise<string> {
  const canonical = canonicalClaims(claims);
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(canonical)));
  const signingInput = `v1.${payload}`;
  const key = await importHmacKey(signingSecret, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function verifyGeminiControlCapabilityV1(
  token: string,
  signingSecret: string,
  nowEpochMs: number,
): Promise<GeminiControlCapabilityClaimsV1 | null> {
  if (typeof token !== "string" || !token.trim()) return null;
  positiveSafeInteger(nowEpochMs, "Gemini control capability nowEpochMs");
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null;

  let signature: Uint8Array<ArrayBuffer>;
  let payloadBytes: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(parts[2]);
    payloadBytes = base64UrlDecode(parts[1]);
  } catch {
    return null;
  }
  if (signature.byteLength !== 32) return null;

  try {
    const key = await importHmacKey(signingSecret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(`v1.${parts[1]}`),
    );
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown;
    const claims = canonicalClaims(parsed);
    if (claims.notAfterEpochMs <= nowEpochMs) return null;
    return claims;
  } catch {
    return null;
  }
}

export function bearerTokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}
