import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { verifyGeminiControlCapabilityV1 } from "../src/control-auth/capability-v1";
import { admitTelnyxRequestInternally } from "../src/telnyx/admission-worker";

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signedRequest() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicRaw = await crypto.subtle.exportKey("raw", keys.publicKey);
  const nowEpochMs = Date.now();
  const occurredAt = new Date(nowEpochMs).toISOString();
  const timestamp = String(Math.floor(nowEpochMs / 1000));
  const rawBody = JSON.stringify({
    data: {
      id: "evt-worker-admission-1",
      occurred_at: occurredAt,
      event_type: "call.initiated",
      payload: {
        direction: "incoming",
        call_control_id: "v3:worker-admission-call",
        call_session_id: "telnyx-worker-session",
        to: "+34 910 000 020",
        from: "+34 600 000 020",
      },
    },
  });
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(`${timestamp}|${rawBody}`),
  );
  return {
    nowEpochMs,
    publicKey: base64(publicRaw),
    request: new Request("https://worker/internal/not-routed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "telnyx-timestamp": timestamp,
        "telnyx-signature-ed25519": base64(signature),
      },
      body: rawBody,
    }),
  };
}

const IDENTITY_SECRET = "0123456789abcdef0123456789abcdef";
const CONTROL_SECRET = "abcdef0123456789abcdef0123456789";
const CONTROL_URL = "wss://gemini-control.example.test/internal/control";

describe("internal Gemini Telnyx admission worker composition", () => {
  it("uses the shared tenant route and returns an authenticated edge-control bootstrap", async () => {
    const fixture = await signedRequest();
    const get = vi.fn(async (key: string) => {
      expect(key).toBe("ia-rtcc:v1:route:phone:+34910000020");
      return JSON.stringify({ schemaVersion: 1, tenantId: "tenant-kv", status: "active" });
    });
    const result = await admitTelnyxRequestInternally(fixture.request, {
      ...env,
      TENANT_CONFIG: { get },
      TELNYX_PUBLIC_KEY: fixture.publicKey,
      GEMINI_ADMISSION_IDENTITY_SECRET: IDENTITY_SECRET,
      GEMINI_CONTROL_CAPABILITY_SECRET: CONTROL_SECRET,
      GEMINI_CONTROL_WSS_URL: CONTROL_URL,
    }, {
      nowEpochMs: fixture.nowEpochMs,
      signatureMaxAgeSeconds: 300,
      admissionTtlMs: 10 * 60_000,
    });

    expect(result.status).toBe("ADMITTED");
    if (result.status !== "ADMITTED") throw new Error("expected admission");
    expect(result.result.registration).toBe("CREATED");
    expect(result.result.admission.tenantId).toBe("tenant-kv");
    expect(result.edgeControlBootstrap.controlUrl).toBe(CONTROL_URL);
    const claims = await verifyGeminiControlCapabilityV1(
      result.edgeControlBootstrap.controlCapability,
      CONTROL_SECRET,
      fixture.nowEpochMs,
    );
    expect(claims?.callSessionId).toBe(result.result.admission.callSessionId);
    expect(claims?.edgeSessionId).toBe(result.result.admission.edgeSessionId);
    expect(claims?.credentialId).toBe(result.result.admission.credentialId);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not touch tenant KV when signature validation fails", async () => {
    const fixture = await signedRequest();
    const get = vi.fn(async () => JSON.stringify({ schemaVersion: 1, tenantId: "tenant-never", status: "active" }));
    const tampered = new Request(fixture.request.url, {
      method: "POST",
      headers: fixture.request.headers,
      body: `${await fixture.request.text()} `,
    });
    const result = await admitTelnyxRequestInternally(tampered, {
      ...env,
      TENANT_CONFIG: { get },
      TELNYX_PUBLIC_KEY: fixture.publicKey,
      GEMINI_ADMISSION_IDENTITY_SECRET: IDENTITY_SECRET,
      GEMINI_CONTROL_CAPABILITY_SECRET: CONTROL_SECRET,
      GEMINI_CONTROL_WSS_URL: CONTROL_URL,
    }, {
      nowEpochMs: fixture.nowEpochMs,
      signatureMaxAgeSeconds: 300,
      admissionTtlMs: 10 * 60_000,
    });
    expect(result).toEqual({ status: "SIGNATURE_REJECTED" });
    expect(get).not.toHaveBeenCalled();
  });
});
