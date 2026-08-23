import type { GeminiMediaEdgeSessionBinding } from "./gemini-media-edge-session-contract.js";

export type GeminiMediaEdgeVerifiedCredential = Readonly<{
  credentialId: string;
  provider: "GEMINI";
  tenantId: string;
  callControlId: string;
  edgeUrl: string;
  targetLegs: GeminiMediaEdgeSessionBinding["targetLegs"];
  notAfterEpochMs: number;
}>;

export type GeminiMediaEdgeCredentialVerifier = (
  rawCredential: string,
) => Promise<GeminiMediaEdgeVerifiedCredential> | GeminiMediaEdgeVerifiedCredential;

/**
 * Must atomically return true exactly once for a credential id. Implementations
 * must be shared/durable enough for the selected media-edge topology; an in-memory
 * Set is not a production implementation when more than one process/instance exists.
 */
export type GeminiMediaEdgeCredentialConsumer = (
  credentialId: string,
  notAfterEpochMs: number,
) => Promise<boolean> | boolean;

export type GeminiMediaEdgeAuthorizedCredential = Readonly<{
  credentialId: string;
  binding: GeminiMediaEdgeSessionBinding;
}>;

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

function targetLegs(value: unknown): GeminiMediaEdgeSessionBinding["targetLegs"] {
  if (!(["self", "opposite", "both"] as const).includes(value as GeminiMediaEdgeSessionBinding["targetLegs"])) {
    throw new Error("Gemini media edge credential target legs are invalid");
  }
  return value as GeminiMediaEdgeSessionBinding["targetLegs"];
}

function secureEdgeUrl(value: unknown, rawCredential: string): string {
  const normalized = required(value, "Gemini media edge credential edge URL");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Gemini media edge credential edge URL is invalid");
  }
  if (parsed.protocol !== "wss:") throw new Error("Gemini media edge credential edge URL must use wss://");
  if (parsed.username || parsed.password) throw new Error("Gemini media edge credential edge URL must not contain credentials");
  if (normalized.includes(rawCredential) || parsed.href.includes(encodeURIComponent(rawCredential))) {
    throw new Error("Gemini media edge credential must not be embedded in the edge URL");
  }
  return parsed.toString();
}

function requireUnexpired(notAfterEpochMs: number, nowEpochMs: number): void {
  if (nowEpochMs >= notAfterEpochMs) throw new Error("Gemini media edge credential expired");
}

/**
 * Cryptographically verifies/resolves an externally-presented media-edge credential
 * and turns its authenticated claims into the session binding authority.
 *
 * There is intentionally no caller-supplied expected tenant/call binding here. The
 * future verifier may validate a self-contained signed token or resolve an opaque
 * token from shared storage; in either case its authenticated claims are the source
 * of the binding later checked against Telnyx's `start.call_control_id`.
 *
 * The raw credential is never returned, and verifier errors are redacted so a crypto
 * or storage library cannot leak the presented secret through an observable error.
 */
export async function verifyGeminiMediaEdgeCredential(
  rawCredential: string,
  nowEpochMs: number,
  verifyCredential: GeminiMediaEdgeCredentialVerifier,
): Promise<GeminiMediaEdgeAuthorizedCredential> {
  const credential = required(rawCredential, "Gemini media edge credential");
  const now = safeEpoch(nowEpochMs, "Gemini media edge nowEpochMs");

  let verified: GeminiMediaEdgeVerifiedCredential;
  try {
    verified = await verifyCredential(credential);
  } catch {
    throw new Error("Gemini media edge credential verification failed");
  }

  const credentialId = required(verified?.credentialId, "Gemini media edge credential id");
  if (credentialId.length > 256) throw new Error("Gemini media edge credential id exceeds 256 characters");
  if (verified.provider !== "GEMINI") throw new Error("Gemini media edge credential provider must be GEMINI");

  const notAfterEpochMs = safeEpoch(verified.notAfterEpochMs, "Gemini media edge credential notAfterEpochMs");
  requireUnexpired(notAfterEpochMs, now);

  const binding: GeminiMediaEdgeSessionBinding = Object.freeze({
    provider: "GEMINI" as const,
    tenantId: required(verified.tenantId, "Gemini media edge credential tenant_id"),
    callControlId: required(verified.callControlId, "Gemini media edge credential call_control_id"),
    edgeUrl: secureEdgeUrl(verified.edgeUrl, credential),
    targetLegs: targetLegs(verified.targetLegs),
    notAfterEpochMs,
  });

  return Object.freeze({ credentialId, binding });
}

/**
 * Atomically consumes an already-verified credential immediately before media is
 * accepted. Expiry is checked again using an explicit authoritative timestamp so a
 * credential cannot become valid at upgrade time and remain usable indefinitely
 * while waiting for the Telnyx identity frame.
 */
export async function consumeGeminiMediaEdgeCredentialOnce(
  authorized: GeminiMediaEdgeAuthorizedCredential,
  nowEpochMs: number,
  consumeCredentialOnce: GeminiMediaEdgeCredentialConsumer,
): Promise<GeminiMediaEdgeAuthorizedCredential> {
  const now = safeEpoch(nowEpochMs, "Gemini media edge consume nowEpochMs");
  requireUnexpired(authorized.binding.notAfterEpochMs, now);

  let consumed: boolean;
  try {
    consumed = await consumeCredentialOnce(authorized.credentialId, authorized.binding.notAfterEpochMs);
  } catch {
    throw new Error("Gemini media edge credential consumption failed");
  }
  if (consumed !== true) throw new Error("Gemini media edge credential already consumed");
  return authorized;
}
