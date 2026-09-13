export type TelnyxWebhookSignatureVerificationInput = Readonly<{
  rawBody: string;
  signatureBase64: string | null;
  timestamp: string | null;
  publicKey: string;
  nowEpochMs: number;
  maxAgeSeconds: number;
}>;

export type TelnyxPublicKeyMaterial = Readonly<{
  format: "raw" | "spki";
  bytes: Uint8Array<ArrayBuffer>;
}>;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function decodeBase64(value: string, field: string): Uint8Array<ArrayBuffer> {
  const normalized = requiredString(value, field).replace(/\s+/g, "");
  let binary: string;
  try { binary = atob(normalized); }
  catch { throw new Error(`${field} is not valid base64`); }
  if (!binary.length) throw new Error(`${field} is empty`);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function decodeTelnyxPublicKey(publicKeyValue: string): TelnyxPublicKeyMaterial {
  const trimmed = requiredString(publicKeyValue, "TELNYX_PUBLIC_KEY");
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    const base64 = trimmed
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s+/g, "");
    return Object.freeze({ format: "spki", bytes: decodeBase64(base64, "TELNYX_PUBLIC_KEY PEM") });
  }
  const bytes = decodeBase64(trimmed, "TELNYX_PUBLIC_KEY");
  return Object.freeze({ format: bytes.byteLength === 32 ? "raw" : "spki", bytes });
}

function boundedPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

/**
 * Verifies the exact Telnyx signed message: `${timestamp}|${raw_json_payload}`.
 * The raw body must be supplied byte-for-byte as received and MUST NOT be
 * parsed/re-serialized before this function runs.
 */
export async function verifyTelnyxWebhookSignature(
  input: TelnyxWebhookSignatureVerificationInput,
): Promise<boolean> {
  if (typeof input.rawBody !== "string" || !input.rawBody.length) return false;
  if (!input.signatureBase64 || !input.timestamp) return false;

  const nowEpochMs = boundedPositiveInteger(input.nowEpochMs, "Telnyx verification nowEpochMs");
  const maxAgeSeconds = boundedPositiveInteger(input.maxAgeSeconds, "Telnyx verification maxAgeSeconds");
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 1) return false;

  const nowSeconds = Math.floor(nowEpochMs / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > maxAgeSeconds) return false;

  let signature: Uint8Array<ArrayBuffer>;
  let publicKey: TelnyxPublicKeyMaterial;
  try {
    signature = decodeBase64(input.signatureBase64, "Telnyx webhook signature");
    publicKey = decodeTelnyxPublicKey(input.publicKey);
  } catch {
    return false;
  }
  if (signature.byteLength !== 64) return false;

  try {
    const key = await crypto.subtle.importKey(
      publicKey.format,
      publicKey.bytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode(`${input.timestamp}|${input.rawBody}`);
    return await crypto.subtle.verify("Ed25519", key, signature, message);
  } catch {
    return false;
  }
}
