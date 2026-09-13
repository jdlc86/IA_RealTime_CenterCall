import { describe, expect, it } from "vitest";
import { decodeTelnyxPublicKey, verifyTelnyxWebhookSignature } from "./webhook-signature";

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pem(spki: ArrayBuffer): string {
  const encoded = base64(spki);
  const lines = encoded.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

async function fixture() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicRaw = await crypto.subtle.exportKey("raw", keys.publicKey);
  const publicSpki = await crypto.subtle.exportKey("spki", keys.publicKey);
  const timestamp = "1787743000";
  const rawBody = '{"data":{"event_type":"call.initiated","payload":{"direction":"incoming"}}}';
  const message = new TextEncoder().encode(`${timestamp}|${rawBody}`);
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, message);
  return { publicRaw, publicSpki, timestamp, rawBody, signatureBase64: base64(signature) };
}

describe("Telnyx webhook Ed25519 verification", () => {
  it("verifies the exact timestamp|raw-body bytes with a raw base64 public key", async () => {
    const value = await fixture();
    expect(await verifyTelnyxWebhookSignature({
      rawBody: value.rawBody,
      signatureBase64: value.signatureBase64,
      timestamp: value.timestamp,
      publicKey: base64(value.publicRaw),
      nowEpochMs: Number(value.timestamp) * 1000,
      maxAgeSeconds: 300,
    })).toBe(true);
  });

  it("accepts the existing PEM/SPKI public-key configuration shape", async () => {
    const value = await fixture();
    const material = decodeTelnyxPublicKey(pem(value.publicSpki));
    expect(material.format).toBe("spki");
    expect(await verifyTelnyxWebhookSignature({
      rawBody: value.rawBody,
      signatureBase64: value.signatureBase64,
      timestamp: value.timestamp,
      publicKey: pem(value.publicSpki),
      nowEpochMs: Number(value.timestamp) * 1000,
      maxAgeSeconds: 300,
    })).toBe(true);
  });

  it("fails closed on body/timestamp tampering, stale requests and malformed key material", async () => {
    const value = await fixture();
    const common = {
      signatureBase64: value.signatureBase64,
      publicKey: base64(value.publicRaw),
      maxAgeSeconds: 300,
    } as const;

    expect(await verifyTelnyxWebhookSignature({
      ...common,
      rawBody: `${value.rawBody} `,
      timestamp: value.timestamp,
      nowEpochMs: Number(value.timestamp) * 1000,
    })).toBe(false);

    expect(await verifyTelnyxWebhookSignature({
      ...common,
      rawBody: value.rawBody,
      timestamp: String(Number(value.timestamp) + 1),
      nowEpochMs: Number(value.timestamp) * 1000,
    })).toBe(false);

    expect(await verifyTelnyxWebhookSignature({
      ...common,
      rawBody: value.rawBody,
      timestamp: value.timestamp,
      nowEpochMs: (Number(value.timestamp) + 301) * 1000,
    })).toBe(false);

    expect(await verifyTelnyxWebhookSignature({
      rawBody: value.rawBody,
      signatureBase64: value.signatureBase64,
      timestamp: value.timestamp,
      publicKey: "not-base64!",
      nowEpochMs: Number(value.timestamp) * 1000,
      maxAgeSeconds: 300,
    })).toBe(false);
  });

  it("fails closed when signature headers are missing or signature length is invalid", async () => {
    const value = await fixture();
    expect(await verifyTelnyxWebhookSignature({
      rawBody: value.rawBody,
      signatureBase64: null,
      timestamp: value.timestamp,
      publicKey: base64(value.publicRaw),
      nowEpochMs: Number(value.timestamp) * 1000,
      maxAgeSeconds: 300,
    })).toBe(false);

    expect(await verifyTelnyxWebhookSignature({
      rawBody: value.rawBody,
      signatureBase64: btoa("short"),
      timestamp: value.timestamp,
      publicKey: base64(value.publicRaw),
      nowEpochMs: Number(value.timestamp) * 1000,
      maxAgeSeconds: 300,
    })).toBe(false);
  });
});
