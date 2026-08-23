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

export type GeminiMediaEdgeCredentialExpectation = Readonly<{
  binding: GeminiMediaEdgeSessionBinding;
  nowEpochMs: number;
}>;

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

function sameBinding(
  verified: GeminiMediaEdgeVerifiedCredential,
  expected: GeminiMediaEdgeSessionBinding,
): boolean {
  return verified.provider === "GEMINI"
    && verified.tenantId === expected.tenantId
    && verified.callControlId === expected.callControlId
    && verified.edgeUrl === expected.edgeUrl
    && verified.targetLegs === expected.targetLegs
    && verified.notAfterEpochMs === expected.notAfterEpochMs;
}

/**
 * Verifies and consumes one externally-presented Gemini media-edge credential.
 *
 * Cryptographic verification and durable replay protection are injected ports so
 * this boundary does not pretend a hosting/key/storage choice has already been made.
 * The authoritative time is also supplied explicitly; Date.now() is intentionally
 * not a hidden authority here.
 *
 * Ordering is security-sensitive: signature/claim verification, exact call binding
 * and expiry are checked before the atomic consume mutation. A token for another
 * call/tenant therefore cannot burn the legitimate call's one-shot credential.
 *
 * Raw credentials are never returned and verifier failures are deliberately wrapped
 * so an upstream library cannot accidentally place the secret into an observable
 * error message.
 */
export async function requireGeminiMediaEdgeCredentialOnce(
  rawCredential: string,
  expectation: GeminiMediaEdgeCredentialExpectation,
  verifyCredential: GeminiMediaEdgeCredentialVerifier,
  consumeCredentialOnce: GeminiMediaEdgeCredentialConsumer,
): Promise<GeminiMediaEdgeAuthorizedCredential> {
  const credential = required(rawCredential, "Gemini media edge credential");
  const nowEpochMs = safeEpoch(expectation.nowEpochMs, "Gemini media edge nowEpochMs");

  let verified: GeminiMediaEdgeVerifiedCredential;
  try {
    verified = await verifyCredential(credential);
  } catch {
    throw new Error("Gemini media edge credential verification failed");
  }

  const credentialId = required(verified?.credentialId, "Gemini media edge credential id");
  if (credentialId.length > 256) throw new Error("Gemini media edge credential id exceeds 256 characters");
  if (!sameBinding(verified, expectation.binding)) {
    throw new Error("Gemini media edge credential binding mismatch");
  }
  const notAfterEpochMs = safeEpoch(verified.notAfterEpochMs, "Gemini media edge credential notAfterEpochMs");
  if (nowEpochMs >= notAfterEpochMs) {
    throw new Error("Gemini media edge credential expired");
  }

  let consumed: boolean;
  try {
    consumed = await consumeCredentialOnce(credentialId, notAfterEpochMs);
  } catch {
    throw new Error("Gemini media edge credential consumption failed");
  }
  if (consumed !== true) throw new Error("Gemini media edge credential already consumed");

  return Object.freeze({
    credentialId,
    binding: Object.freeze({ ...expectation.binding }),
  });
}
