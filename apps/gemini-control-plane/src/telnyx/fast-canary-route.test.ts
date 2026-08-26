import { describe, expect, it } from "vitest";
import { routeFastGeminiCanaryWebhook, type FastGeminiCanaryEnv } from "./fast-canary-route";
import type { FastIncomingRuntimeResult } from "./fast-incoming-runtime";
import type { VerifiedTelnyxIncomingCall } from "./incoming-call";

const ENV: FastGeminiCanaryEnv = {
  TELNYX_PUBLIC_KEY: "test-public-key",
  TELNYX_API_KEY: "test-api-key",
  GEMINI_ADMISSION_IDENTITY_SECRET: "0123456789abcdef0123456789abcdef",
  GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN: "0123456789abcdef0123456789abcdef",
  GEMINI_FAST_CANARY_EDGE_URL: "wss://fast-canary.example/telnyx/gemini",
  GEMINI_FAST_CANARY_CALLED_NUMBER: "+34 600 000 001",
  GEMINI_FAST_CANARY_TENANT_ID: "tenant-fast-canary",
  GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION: "Habla en español de forma breve y natural.",
};

const CALL: VerifiedTelnyxIncomingCall = {
  eventId: "evt-fast-canary",
  occurredAt: "2026-08-26T13:14:00.000Z",
  occurredAtEpochMs: Date.parse("2026-08-26T13:14:00.000Z"),
  callControlId: "v3:fast-canary",
  telnyxCallSessionId: "session-fast-canary",
  calledNumber: "+34600000001",
  callerNumber: "+34600000002",
};

function request(method = "POST"): Request {
  return new Request("https://gemini.example/webhooks/telnyx/fast-canary", {
    method,
    headers: {
      "content-type": "application/json",
      "telnyx-signature-ed25519": "signature",
      "telnyx-timestamp": "1787750040",
    },
    body: method === "POST" ? JSON.stringify({ data: { event_type: "call.initiated" } }) : undefined,
  });
}

describe("fast Gemini canary webhook", () => {
  it("admits only the exact canary called number and forces audio-only session config", async () => {
    const response = await routeFastGeminiCanaryWebhook(request(), ENV, {
      now: () => Date.parse("2026-08-26T13:14:01.000Z"),
      startIncoming: async (_input, options): Promise<FastIncomingRuntimeResult> => {
        expect(options.edgeUrl).toBe("wss://fast-canary.example/telnyx/gemini");
        expect(options.admissionTtlMs).toBe(60_000);
        expect(options.signatureMaxAgeSeconds).toBe(300);
        expect(await options.resolveTenantId(CALL)).toBe("tenant-fast-canary");
        expect(options.isCanaryAllowed("tenant-fast-canary", CALL)).toBe(true);
        const otherNumber = { ...CALL, calledNumber: "+34600000999" };
        expect(await options.resolveTenantId(otherNumber)).toBeNull();
        expect(options.isCanaryAllowed("tenant-fast-canary", otherNumber)).toBe(false);
        const config = await options.resolveSessionConfig("tenant-fast-canary", CALL);
        expect(config).toEqual({
          systemInstruction: "Habla en español de forma breve y natural.",
          tools: [],
          voiceName: "Kore",
          languageCode: "es-ES",
        });
        return {
          status: "STARTED",
          call: CALL,
          tenantId: "tenant-fast-canary",
          credentialId: "credential-fast",
          edgeUrl: ENV.GEMINI_FAST_CANARY_EDGE_URL,
        };
      },
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, status: "STARTED" });
  });

  it("forwards Telnyx signature headers to the signed pre-call runtime", async () => {
    let signedInput: { signatureBase64: string | null; timestamp: string | null } | null = null;
    const response = await routeFastGeminiCanaryWebhook(request(), ENV, {
      startIncoming: async (input): Promise<FastIncomingRuntimeResult> => {
        signedInput = { signatureBase64: input.signatureBase64, timestamp: input.timestamp };
        return { status: "SIGNATURE_REJECTED" };
      },
    });
    expect(response.status).toBe(401);
    expect(signedInput).toEqual({ signatureBase64: "signature", timestamp: "1787750040" });
  });

  it("maps non-initiation and closed-gate outcomes without leaking call identity", async () => {
    for (const status of ["IGNORED_EVENT", "TENANT_NOT_FOUND", "CANARY_NOT_ALLOWED"] as const) {
      const response = await routeFastGeminiCanaryWebhook(request(), ENV, {
        startIncoming: async (): Promise<FastIncomingRuntimeResult> => {
          if (status === "IGNORED_EVENT") return { status };
          if (status === "TENANT_NOT_FOUND") return { status, call: CALL };
          return { status, call: CALL, tenantId: "tenant-fast-canary" };
        },
      });
      if (status === "IGNORED_EVENT") {
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
      } else {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ ok: false, status });
      }
    }
  });

  it("rejects non-POST requests before any runtime side effect", async () => {
    let called = false;
    const response = await routeFastGeminiCanaryWebhook(request("GET"), ENV, {
      startIncoming: async (): Promise<FastIncomingRuntimeResult> => {
        called = true;
        return { status: "SIGNATURE_REJECTED" };
      },
    });
    expect(response.status).toBe(405);
    expect(called).toBe(false);
  });
});
