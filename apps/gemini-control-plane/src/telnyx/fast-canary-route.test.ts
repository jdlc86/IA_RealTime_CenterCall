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
  GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION: "Habla en español de forma breve y natural.",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-for-tests-only",
  CALLER_SECURITY_HMAC_SECRET: "shared-caller-identity-secret",
  TENANT_ROUTING_KV: {
    async get(key: string) {
      if (key === "tenant_by_phone:+34600000001") {
        return JSON.stringify({ tenant_id: "tenant-fast-canary", route_id: "default", enabled: true });
      }
      return null;
    },
  },
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
  it("uses the enabled KV route and injects temporal plus semantic security authority", async () => {
    const callStart = Date.parse("2026-08-26T13:14:01.000Z");
    const response = await routeFastGeminiCanaryWebhook(request(), ENV, {
      now: () => callStart,
      callerSecurityFetcher: async () => Response.json([{ decision: "ALLOW", reason: "OK" }]),
      startIncoming: async (_input, options): Promise<FastIncomingRuntimeResult> => {
        expect(options.edgeUrl).toBe("wss://fast-canary.example/telnyx/gemini");
        expect(options.admissionTtlMs).toBe(60_000);
        expect(options.signatureMaxAgeSeconds).toBe(300);
        expect(options.nowEpochMs).toBe(callStart);
        expect(await options.resolveTenantRoute!(CALL)).toEqual({ tenantId: "tenant-fast-canary", routeId: "default" });
        expect(options.isCanaryAllowed("tenant-fast-canary", CALL)).toBe(true);
        await expect(options.evaluateCallerSecurity({
          eventKey: CALL.eventId,
          tenantId: "tenant-fast-canary",
          callerPhone: CALL.callerNumber!,
        })).resolves.toEqual({ decision: "ALLOW", reason: "OK" });
        const otherNumber = { ...CALL, calledNumber: "+34600000999" };
        expect(await options.resolveTenantRoute!(otherNumber)).toBeNull();
        const config = await options.resolveSessionConfig("tenant-fast-canary", CALL);
        expect(config.voiceName).toBe("Kore");
        expect(config.languageCode).toBe("es-ES");
        expect(config.systemInstruction).toContain("Habla en español de forma breve y natural.");
        expect(config.systemInstruction).toContain("Autoridad temporal del kernel:");
        expect(config.systemInstruction).toContain('"source":"WORKER_CLOCK"');
        expect(config.systemInstruction).toContain('"timezone":"Europe/Madrid"');
        expect(config.systemInstruction).toContain('"now_iso":"2026-08-26T15:14:01+02:00"');
        expect(config.systemInstruction).toContain("get_authoritative_datetime");
        expect(config.systemInstruction).toContain("Frontera semántica de seguridad:");
        expect(config.systemInstruction).toContain("No decidas por keywords, frases rígidas o coincidencias léxicas");
        expect(config.systemInstruction).toContain("report_semantic_security_incident");
        expect(config.tools?.map((tool) => tool.name)).toEqual([
          "get_authoritative_datetime",
          "report_semantic_security_incident",
        ]);
        expect(config.tools?.map((tool) => tool.capability)).toEqual([
          "time.authoritative",
          "security.semantic_boundary",
        ]);
        return {
          status: "STARTED",
          call: CALL,
          tenantId: "tenant-fast-canary",
          routeId: "default",
          credentialId: "credential-fast",
          edgeUrl: ENV.GEMINI_FAST_CANARY_EDGE_URL,
        };
      },
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, status: "STARTED" });
  });

  it("uses the tenant business timezone for the signed temporal snapshot", async () => {
    const env: FastGeminiCanaryEnv = {
      ...ENV,
      TENANT_ROUTING_KV: {
        async get(key: string) {
          if (key === "tenant_by_phone:+34600000001") {
            return JSON.stringify({ tenant_id: "tenant-fast-canary", route_id: "default", enabled: true });
          }
          if (key === "tenant_config:tenant-fast-canary") {
            return JSON.stringify({
              tenant_id: "tenant-fast-canary",
              status: "active",
              business: { timezone: "America/Bogota" },
            });
          }
          return null;
        },
      },
    };
    const response = await routeFastGeminiCanaryWebhook(request(), env, {
      now: () => Date.parse("2026-08-26T14:14:01.000Z"),
      startIncoming: async (_input, options): Promise<FastIncomingRuntimeResult> => {
        const config = await options.resolveSessionConfig("tenant-fast-canary", CALL);
        expect(config.systemInstruction).toContain('"timezone":"America/Bogota"');
        expect(config.systemInstruction).toContain('"now_iso":"2026-08-26T09:14:01-05:00"');
        return {
          status: "STARTED",
          call: CALL,
          tenantId: "tenant-fast-canary",
          routeId: "default",
          credentialId: "credential-fast",
          edgeUrl: env.GEMINI_FAST_CANARY_EDGE_URL,
        };
      },
    });
    expect(response.status).toBe(202);
  });

  it("resolves tenant and route with one KV read keyed by the called E.164 number", async () => {
    const keys: string[] = [];
    const env: FastGeminiCanaryEnv = {
      ...ENV,
      TENANT_ROUTING_KV: {
        async get(key: string) {
          keys.push(key);
          return JSON.stringify({ tenant_id: "tenant-fast-canary", route_id: "reservas", enabled: true });
        },
      },
    };
    const response = await routeFastGeminiCanaryWebhook(request(), env, {
      startIncoming: async (_input, options): Promise<FastIncomingRuntimeResult> => {
        expect(await options.resolveTenantRoute!(CALL)).toEqual({ tenantId: "tenant-fast-canary", routeId: "reservas" });
        return {
          status: "STARTED",
          call: CALL,
          tenantId: "tenant-fast-canary",
          routeId: "reservas",
          credentialId: "credential-fast",
          edgeUrl: ENV.GEMINI_FAST_CANARY_EDGE_URL,
        };
      },
    });
    expect(response.status).toBe(202);
    expect(keys).toEqual(["tenant_by_phone:+34600000001"]);
  });

  it("fails closed when the called number has no KV route", async () => {
    const env: FastGeminiCanaryEnv = {
      ...ENV,
      TENANT_ROUTING_KV: { async get() { return null; } },
    };
    const response = await routeFastGeminiCanaryWebhook(request(), env, {
      startIncoming: async (_input, options): Promise<FastIncomingRuntimeResult> => {
        expect(await options.resolveTenantRoute!(CALL)).toBeNull();
        return { status: "TENANT_NOT_FOUND", call: CALL };
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, status: "TENANT_NOT_FOUND" });
  });

  it("fails closed when the KV route is disabled", async () => {
    const env: FastGeminiCanaryEnv = {
      ...ENV,
      TENANT_ROUTING_KV: {
        async get() {
          return JSON.stringify({ tenant_id: "tenant-fast-canary", route_id: "default", enabled: false });
        },
      },
    };
    const response = await routeFastGeminiCanaryWebhook(request(), env, {
      startIncoming: async (_input, options): Promise<FastIncomingRuntimeResult> => {
        expect(await options.resolveTenantRoute!(CALL)).toBeNull();
        return { status: "TENANT_NOT_FOUND", call: CALL };
      },
    });
    expect(response.status).toBe(403);
  });

  it("fails closed when inbound caller-security configuration is unavailable", async () => {
    const env: FastGeminiCanaryEnv = {
      ...ENV,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    };
    await expect(routeFastGeminiCanaryWebhook(request(), env, {
      startIncoming: async (_input, options): Promise<FastIncomingRuntimeResult> => {
        await options.evaluateCallerSecurity({
          eventKey: CALL.eventId,
          tenantId: "tenant-fast-canary",
          callerPhone: CALL.callerNumber!,
        });
        throw new Error("must not continue");
      },
    })).rejects.toThrow("SUPABASE_SERVICE_ROLE_KEY is required");
  });

  it("fails closed before media side effects when capabilities belong to another tenant", async () => {
    let mediaStarted = false;
    const env: FastGeminiCanaryEnv = {
      ...ENV,
      TENANT_ROUTING_KV: {
        async get(key: string) {
          if (key === "tenant_by_phone:+34600000001") {
            return JSON.stringify({ tenant_id: "tenant-fast-canary", route_id: "default", enabled: true });
          }
          if (key === "tenant_capabilities:tenant-fast-canary") {
            return JSON.stringify({ tenant_id: "tenant-other", "call.transfer": true });
          }
          return null;
        },
      },
    };
    await expect(routeFastGeminiCanaryWebhook(request(), env, {
      startIncoming: async (_input, options): Promise<FastIncomingRuntimeResult> => {
        await options.resolveSessionConfig("tenant-fast-canary", CALL);
        mediaStarted = true;
        return {
          status: "STARTED",
          call: CALL,
          tenantId: "tenant-fast-canary",
          routeId: "default",
          credentialId: "credential-fast",
          edgeUrl: env.GEMINI_FAST_CANARY_EDGE_URL,
        };
      },
    })).rejects.toThrow("Tenant capabilities tenant mismatch");
    expect(mediaStarted).toBe(false);
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
    for (const status of ["IGNORED_EVENT", "TENANT_NOT_FOUND", "CANARY_NOT_ALLOWED", "CALLER_SECURITY_BLOCKED"] as const) {
      const response = await routeFastGeminiCanaryWebhook(request(), ENV, {
        startIncoming: async (): Promise<FastIncomingRuntimeResult> => {
          if (status === "IGNORED_EVENT") return { status };
          if (status === "TENANT_NOT_FOUND") return { status, call: CALL };
          if (status === "CALLER_SECURITY_BLOCKED") return { status, call: CALL, tenantId: "tenant-fast-canary", reason: "CALL_RATE_1M" };
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
