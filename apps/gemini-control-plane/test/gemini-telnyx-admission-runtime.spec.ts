import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { verifyGeminiControlCapabilityV1 } from "../src/control-auth/capability-v1";
import { admitSignedTelnyxIncomingCall } from "../src/telnyx/admission-runtime";

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signedFixture() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicRaw = await crypto.subtle.exportKey("raw", keys.publicKey);
  const nowEpochMs = Date.now();
  const occurredAt = new Date(nowEpochMs).toISOString();
  const timestamp = String(Math.floor(nowEpochMs / 1000));
  const rawBody = JSON.stringify({
    data: {
      id: "evt-signed-admission-1",
      occurred_at: occurredAt,
      event_type: "call.initiated",
      payload: {
        direction: "incoming",
        call_control_id: "v3:signed-admission-call",
        call_session_id: "telnyx-signed-session",
        to: "+34910000010",
        from: "+34600000010",
      },
    },
  });
  const message = new TextEncoder().encode(`${timestamp}|${rawBody}`);
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, message);
  return { nowEpochMs, timestamp, rawBody, signatureBase64: base64(signature), publicKey: base64(publicRaw) };
}

const IDENTITY_SECRET = "0123456789abcdef0123456789abcdef";
const CONTROL_SECRET = "abcdef0123456789abcdef0123456789";
const CONTROL_URL = "wss://gemini-control.example.test/internal/control";

describe("signed Telnyx Gemini admission runtime", () => {
  it("registers retry-stable admission and returns matching edge control bootstrap", async () => {
    const fixture = await signedFixture();
    const resolveTenantId = vi.fn(async () => "tenant-signed");
    const options = {
      nowEpochMs: fixture.nowEpochMs,
      signatureMaxAgeSeconds: 300,
      admissionTtlMs: 10 * 60_000,
      telnyxPublicKey: fixture.publicKey,
      admissionIdentitySecret: IDENTITY_SECRET,
      controlCapabilitySecret: CONTROL_SECRET,
      controlUrl: CONTROL_URL,
      resolveTenantId,
    };

    const first = await admitSignedTelnyxIncomingCall(env, {
      rawBody: fixture.rawBody,
      signatureBase64: fixture.signatureBase64,
      timestamp: fixture.timestamp,
    }, options);
    expect(first.status).toBe("ADMITTED");
    if (first.status !== "ADMITTED") throw new Error("expected admitted result");
    expect(first.result.registration).toBe("CREATED");
    expect(first.edgeControlBootstrap.controlUrl).toBe(CONTROL_URL);
    expect(first.edgeControlBootstrap.callSessionId).toBe(first.result.admission.callSessionId);
    expect(first.edgeControlBootstrap.edgeSessionId).toBe(first.result.admission.edgeSessionId);
    expect(first.edgeControlBootstrap.credentialId).toBe(first.result.admission.credentialId);

    const capability = await verifyGeminiControlCapabilityV1(
      first.edgeControlBootstrap.controlCapability,
      CONTROL_SECRET,
      fixture.nowEpochMs,
    );
    expect(capability?.tenantId).toBe(first.result.admission.tenantId);
    expect(capability?.callControlId).toBe(first.result.admission.callControlId);
    expect(capability?.callSessionId).toBe(first.result.admission.callSessionId);
    expect(capability?.edgeSessionId).toBe(first.result.admission.edgeSessionId);
    expect(capability?.credentialId).toBe(first.result.admission.credentialId);
    expect(capability?.notAfterEpochMs).toBe(first.result.admission.notAfterEpochMs);

    const retry = await admitSignedTelnyxIncomingCall(env, {
      rawBody: fixture.rawBody,
      signatureBase64: fixture.signatureBase64,
      timestamp: fixture.timestamp,
    }, options);
    expect(retry.status).toBe("ADMITTED");
    if (retry.status !== "ADMITTED") throw new Error("expected admitted retry");
    expect(retry.result.registration).toBe("IDEMPOTENT");
    expect(retry.result.admission).toEqual(first.result.admission);
    expect(retry.edgeControlBootstrap).toEqual(first.edgeControlBootstrap);
    expect(resolveTenantId).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid signature before parsing or tenant resolution", async () => {
    const fixture = await signedFixture();
    const resolveTenantId = vi.fn(async () => "tenant-never");
    const result = await admitSignedTelnyxIncomingCall(env, {
      rawBody: `${fixture.rawBody} `,
      signatureBase64: fixture.signatureBase64,
      timestamp: fixture.timestamp,
    }, {
      nowEpochMs: fixture.nowEpochMs,
      signatureMaxAgeSeconds: 300,
      admissionTtlMs: 10 * 60_000,
      telnyxPublicKey: fixture.publicKey,
      admissionIdentitySecret: IDENTITY_SECRET,
      controlCapabilitySecret: CONTROL_SECRET,
      controlUrl: CONTROL_URL,
      resolveTenantId,
    });
    expect(result).toEqual({ status: "SIGNATURE_REJECTED" });
    expect(resolveTenantId).not.toHaveBeenCalled();
  });

  it("returns TENANT_NOT_FOUND without creating an admission", async () => {
    const fixture = await signedFixture();
    const result = await admitSignedTelnyxIncomingCall(env, {
      rawBody: fixture.rawBody,
      signatureBase64: fixture.signatureBase64,
      timestamp: fixture.timestamp,
    }, {
      nowEpochMs: fixture.nowEpochMs,
      signatureMaxAgeSeconds: 300,
      admissionTtlMs: 10 * 60_000,
      telnyxPublicKey: fixture.publicKey,
      admissionIdentitySecret: IDENTITY_SECRET,
      controlCapabilitySecret: CONTROL_SECRET,
      controlUrl: CONTROL_URL,
      resolveTenantId: async () => null,
    });
    expect(result.status).toBe("TENANT_NOT_FOUND");
  });
});
