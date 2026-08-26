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
  const nowEpochMs = Date.parse("2026-08-26T11:40:00.000Z");
  const timestamp = String(Math.floor(nowEpochMs / 1000));
  const rawBody = JSON.stringify({
    data: {
      id: "evt-signed-admission-1",
      occurred_at: "2026-08-26T11:40:00.000Z",
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
  return {
    nowEpochMs,
    timestamp,
    rawBody,
    signatureBase64: base64(signature),
    publicKey: base64(publicRaw),
  };
}

const IDENTITY_SECRET = "0123456789abcdef0123456789abcdef";
const CONTROL_SECRET = "abcdef0123456789abcdef0123456789";

describe("signed Telnyx Gemini admission runtime", () => {
  it("authenticates raw body, resolves tenant and registers a retry-stable admission", async () => {
    const fixture = await signedFixture();
    const resolveTenantId = vi.fn(async () => "tenant-signed");
    const options = {
      nowEpochMs: fixture.nowEpochMs,
      signatureMaxAgeSeconds: 300,
      admissionTtlMs: 10 * 60_000,
      telnyxPublicKey: fixture.publicKey,
      admissionIdentitySecret: IDENTITY_SECRET,
      controlCapabilitySecret: CONTROL_SECRET,
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
    expect(first.result.admission.tenantId).toBe("tenant-signed");
    expect(first.result.admission.callControlId).toBe("v3:signed-admission-call");
    expect(first.result.admission.callSessionId).toMatch(/^cs_/);
    expect(first.result.admission.edgeSessionId).toMatch(/^edge_/);
    expect(first.result.admission.credentialId).toMatch(/^cred_/);

    const capability = await verifyGeminiControlCapabilityV1(first.controlCapability, CONTROL_SECRET, fixture.nowEpochMs);
    expect(capability).not.toBeNull();
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
    expect(retry.controlCapability).toBe(first.controlCapability);
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
      resolveTenantId: async () => null,
    });
    expect(result.status).toBe("TENANT_NOT_FOUND");
  });
});
