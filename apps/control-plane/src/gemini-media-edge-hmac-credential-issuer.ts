import type { GeminiMediaEdgeCredentialClaims, GeminiMediaEdgeCredentialIssuer } from "./gemini-media-edge-admission-composition.js";
import type { GeminiMediaEdgeVerifiedCredential } from "./gemini-media-edge-credential-consumption.js";

export type GeminiMediaEdgeHmacCredentialIssuerInput = GeminiMediaEdgeVerifiedCredential;
export type GeminiMediaEdgeCredentialIdFactory = () => string;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function safeEpoch(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function targetLegs(value: unknown): GeminiMediaEdgeVerifiedCredential["targetLegs"] {
  if (!(["self", "opposite", "both"] as const).includes(value as GeminiMediaEdgeVerifiedCredential["targetLegs"])) {
    throw new Error("Gemini media edge credential target legs are invalid");
  }
  return value as GeminiMediaEdgeVerifiedCredential["targetLegs"];
}

function secureEdgeUrl(value: unknown): string {
  const normalized = required(value, "Gemini media edge credential edge URL");
  let parsed: URL;
  try { parsed = new URL(normalized); }
  catch { throw new Error("Gemini media edge credential edge URL is invalid"); }
  if (parsed.protocol !== "wss:") throw new Error("Gemini media edge credential edge URL must use wss://");
  if (parsed.username || parsed.password) throw new Error("Gemini media edge credential edge URL must not contain credentials");
  return parsed.toString();
}

function canonicalClaims(input: GeminiMediaEdgeHmacCredentialIssuerInput): GeminiMediaEdgeVerifiedCredential {
  if (input.provider !== "GEMINI") throw new Error("Gemini media edge credential provider must be GEMINI");
  const credentialId = required(input.credentialId, "Gemini media edge credential id");
  if (credentialId.length > 256) throw new Error("Gemini media edge credential id exceeds 256 characters");
  return Object.freeze({
    credentialId,
    provider: "GEMINI" as const,
    tenantId: required(input.tenantId, "Gemini media edge credential tenant_id"),
    callControlId: required(input.callControlId, "Gemini media edge credential call_control_id"),
    edgeUrl: secureEdgeUrl(input.edgeUrl),
    targetLegs: targetLegs(input.targetLegs),
    notAfterEpochMs: safeEpoch(input.notAfterEpochMs, "Gemini media edge credential notAfterEpochMs"),
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Issues the exact self-contained v1 credential understood by the standalone
 * Gemini media edge. The credential is intentionally short-lived and contains
 * only the authenticated session binding plus a unique credential id; no Gemini
 * API key, Telnyx API key, or other provider secret is embedded.
 *
 * One-shot replay prevention is still enforced by the edge consumer at Telnyx
 * start time. HMAC authentication alone does not provide replay protection.
 */
export async function issueGeminiMediaEdgeHmacCredential(
  input: GeminiMediaEdgeHmacCredentialIssuerInput,
  signingSecret: string,
): Promise<string> {
  const claims = canonicalClaims(input);
  const secret = required(signingSecret, "Gemini media edge credential signing secret");
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);
  if (secretBytes.byteLength < 32) {
    throw new Error("Gemini media edge credential signing secret must be at least 32 bytes");
  }

  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `v1.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput)));
  return `${signingInput}.${base64Url(signature)}`;
}

/**
 * Adapter used directly by requireGeminiMediaEdgeProvisioningReady. Credential id
 * creation is injected so tests and future durable issuance can own identity, while
 * the default remains a cryptographically strong random UUID in Workers.
 */
export function createGeminiMediaEdgeHmacCredentialIssuer(
  signingSecret: string,
  createCredentialId: GeminiMediaEdgeCredentialIdFactory = () => crypto.randomUUID(),
): GeminiMediaEdgeCredentialIssuer {
  const secret = required(signingSecret, "Gemini media edge credential signing secret");
  return async (claims: GeminiMediaEdgeCredentialClaims) => {
    const credentialId = required(createCredentialId(), "Gemini media edge credential id");
    const streamAuthToken = await issueGeminiMediaEdgeHmacCredential(
      Object.freeze({ credentialId, ...claims }),
      secret,
    );
    return Object.freeze({ streamAuthToken });
  };
}
