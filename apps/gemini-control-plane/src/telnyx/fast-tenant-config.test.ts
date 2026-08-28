import { describe, expect, it } from "vitest";
import { routeFastGeminiCanaryWebhook, type FastGeminiCanaryEnv } from "./fast-canary-route";
import type { FastIncomingRuntimeResult } from "./fast-incoming-runtime";
import type { VerifiedTelnyxIncomingCall } from "./incoming-call";

const CALL: VerifiedTelnyxIncomingCall = {
  eventId: "evt-tenant-config",
  occurredAt: "2026-08-27T13:00:00.000Z",
  occurredAtEpochMs: Date.parse("2026-08-27T13:00:00.000Z"),
  callControlId: "v3:tenant-config",
  telnyxCallSessionId: "session-tenant-config",
  calledNumber: "+34910788224",
  callerNumber: "+34600000002",
};

function request(): Request {
  return new Request("https://gemini.example/webhooks/telnyx/fast-canary", {
    method: "POST",
    headers: {
      "telnyx-signature-ed25519": "signature",
      "telnyx-timestamp": "1787835600",
    },
    body: JSON.stringify({ data: { event_type: "call.initiated" } }),
  });
}

describe("tenant KV session configuration", () => {
  it("loads tenant config, capabilities, temporal authority and semantic security before media starts without overriding realtime voice/VAD", async () => {
    const keys: string[] = [];
    const env: FastGeminiCanaryEnv = {
      TELNYX_PUBLIC_KEY: "test-public-key",
      TELNYX_API_KEY: "test-api-key",
      GEMINI_ADMISSION_IDENTITY_SECRET: "0123456789abcdef0123456789abcdef",
      GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
      GEMINI_MEDIA_CONTROL_PLANE_TOKEN: "0123456789abcdef0123456789abcdef",
      GEMINI_FAST_CANARY_EDGE_URL: "wss://fast-canary.example/telnyx/gemini",
      GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION: "Base estable del agente.",
      TENANT_ROUTING_KV: {
        async get(key: string) {
          keys.push(key);
          if (key === "tenant_by_phone:+34910788224") {
            return JSON.stringify({ tenant_id: "restaurante-centro", route_id: "default", enabled: true });
          }
          if (key === "tenant_config:restaurante-centro") {
            return JSON.stringify({
              schemaVersion: 2,
              tenantId: "restaurante-centro",
              status: "active",
              business: { displayName: "Restaurante Centro" },
              assistant: {
                name: "Lucía",
                greeting: "Buenas, soy Lucía.",
                language: "es-ES",
                waitingPhrases: ["Un momento, consulto esa información."],
              },
              realtime: {
                voice: "marin",
                vad: { threshold: 0.5, prefixPaddingMs: 300, silenceDurationMs: 500, idleTimeoutMs: 10000 },
              },
            });
          }
          if (key === "tenant_capabilities:restaurante-centro") {
            return JSON.stringify({
              tenant_id: "restaurante-centro",
              call: { transfer: true },
              whatsapp: { transactional: true, realtime_support: false },
            });
          }
          return null;
        },
      },
    };

    const response = await routeFastGeminiCanaryWebhook(request(), env, {
      now: () => Date.parse("2026-08-27T13:00:01.000Z"),
      startIncoming: async (_input, options): Promise<FastIncomingRuntimeResult> => {
        expect(await options.resolveTenantRoute!(CALL)).toEqual({ tenantId: "restaurante-centro", routeId: "default" });
        const config = await options.resolveSessionConfig("restaurante-centro", CALL);
        expect(config.voiceName).toBe("Kore");
        expect(config.languageCode).toBe("es-ES");
        expect(config.tools?.map((tool) => tool.name)).toEqual([
          "get_authoritative_datetime",
          "report_semantic_security_incident",
        ]);
        expect(config.systemInstruction).toContain("Base estable del agente.");
        expect(config.systemInstruction).toContain("Negocio: Restaurante Centro.");
        expect(config.systemInstruction).toContain("Tu nombre de asistente es Lucía.");
        expect(config.systemInstruction).toContain("call.transfer=true");
        expect(config.systemInstruction).toContain("message.whatsapp.transactional=true");
        expect(config.systemInstruction).toContain("message.whatsapp.realtime_support=false");
        expect(config.systemInstruction).toContain("Autoridad temporal del kernel:");
        expect(config.systemInstruction).toContain('"source":"WORKER_CLOCK"');
        expect(config.systemInstruction).toContain('"timezone":"Europe/Madrid"');
        expect(config.systemInstruction).toContain('"now_iso":"2026-08-27T15:00:01+02:00"');
        expect(config.systemInstruction).toContain("Frontera semántica de seguridad:");
        expect(config.systemInstruction).toContain("report_semantic_security_incident");
        expect(config.systemInstruction).not.toContain("threshold");
        expect(config.systemInstruction).not.toContain("idleTimeoutMs");
        return {
          status: "STARTED",
          call: CALL,
          tenantId: "restaurante-centro",
          routeId: "default",
          credentialId: "credential-config",
          edgeUrl: env.GEMINI_FAST_CANARY_EDGE_URL,
        };
      },
    });

    expect(response.status).toBe(202);
    expect(keys).toEqual([
      "tenant_by_phone:+34910788224",
      "tenant_config:restaurante-centro",
      "tenant_capabilities:restaurante-centro",
    ]);
  });
});
