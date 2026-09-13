import { describe, expect, it, vi } from "vitest";
import {
  evaluateFastInboundCallerSecurity,
  fastCallerKey,
  persistFastCallerSecuritySignal,
  recordFastCallerSecuritySignalDurably,
  type QueuedFastCallerSecuritySignal,
} from "./fast-caller-security";

const baseEnv = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-for-tests-only",
  CALLER_SECURITY_HMAC_SECRET: "shared-caller-identity-secret",
};
const input = {
  eventKey: `gemini-fast-semsec-v1:${"b".repeat(64)}`,
  tenantId: "tenant-a",
  callerPhone: "+34600000000",
  eventType: "GEMINI_SEMANTIC_PROMPT_INJECTION",
  severity: "MEDIUM" as const,
  riskDelta: 1,
  highConfidence: false,
  metadata: { source: "GEMINI_FAST_SEMANTIC_BOUNDARY", raw_transcript_stored: false },
};

describe("Gemini-native caller security persistence", () => {
  it("preserves the historical tenant-and-caller HMAC identity", async () => {
    expect(await fastCallerKey(baseEnv, "tenant-a", "+34600000000"))
      .toBe("d2724986bb32ddda62ba9fc8a0a989f99cc0616586a58dd6511c72317c0b8310");
    expect(await fastCallerKey(baseEnv, "tenant-b", "+34600000000"))
      .not.toBe(await fastCallerKey(baseEnv, "tenant-a", "+34600000000"));
  });

  it("calls the locked-down idempotent RPC with the service credential", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://project.supabase.co/rest/v1/rpc/record_caller_security_signal_v2");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${baseEnv.SUPABASE_SERVICE_ROLE_KEY}`);
      expect(headers.get("apikey")).toBe(baseEnv.SUPABASE_SERVICE_ROLE_KEY);
      const body = JSON.parse(String(init?.body));
      expect(body.p_event_key).toBe(input.eventKey);
      expect(body.p_caller_key).toBe("d2724986bb32ddda62ba9fc8a0a989f99cc0616586a58dd6511c72317c0b8310");
      expect(JSON.stringify(body)).not.toContain(input.callerPhone);
      return Response.json([{ action: "ALLOW_FUTURE_CALLS" }]);
    });
    await persistFastCallerSecuritySignal(baseEnv, {
      ...input,
      callerKey: await fastCallerKey(baseEnv, input.tenantId, input.callerPhone),
    }, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("evaluates signed inbound admission through the locked-down RPC without clear phone data", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://project.supabase.co/rest/v1/rpc/evaluate_inbound_call_security_v2");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${baseEnv.SUPABASE_SERVICE_ROLE_KEY}`);
      expect(headers.get("apikey")).toBe(baseEnv.SUPABASE_SERVICE_ROLE_KEY);
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        p_event_key: "evt-fast-001",
        p_tenant_id: "tenant-a",
        p_caller_key: "d2724986bb32ddda62ba9fc8a0a989f99cc0616586a58dd6511c72317c0b8310",
      });
      expect(JSON.stringify(body)).not.toContain("+34600000000");
      return Response.json([{ decision: "ALLOW", reason: "OK" }]);
    });

    await expect(evaluateFastInboundCallerSecurity(baseEnv, {
      eventKey: "evt-fast-001",
      tenantId: "tenant-a",
      callerPhone: "+34600000000",
    }, fetcher)).resolves.toEqual({ decision: "ALLOW", reason: "OK" });
  });

  it("fails closed on malformed or unsuccessful admission responses", async () => {
    const request = { eventKey: "evt-fast-001", tenantId: "tenant-a", callerPhone: "+34600000000" };
    await expect(evaluateFastInboundCallerSecurity(baseEnv, request, async () => Response.json([])))
      .rejects.toThrow("empty payload");
    await expect(evaluateFastInboundCallerSecurity(baseEnv, request, async () => Response.json([{ decision: "MAYBE" }])))
      .rejects.toThrow("invalid payload");
    await expect(evaluateFastInboundCallerSecurity(baseEnv, request, async () => new Response("unavailable", { status: 503 })))
      .rejects.toThrow("HTTP 503");
  });

  it("falls back to its Gemini-owned queue without phone or transcript", async () => {
    let queued: QueuedFastCallerSecuritySignal | undefined;
    const queue = {
      async send(body: QueuedFastCallerSecuritySignal) { queued = body; },
    } as unknown as Queue<QueuedFastCallerSecuritySignal>;
    const fetcher = vi.fn();
    const result = await recordFastCallerSecuritySignalDurably({
      ...baseEnv,
      GEMINI_CALLER_SECURITY_SIGNALS: queue,
    }, input, fetcher);
    expect(result.delivery).toBe("QUEUED");
    expect(fetcher).not.toHaveBeenCalled();
    expect(queued?.eventKey).toBe(input.eventKey);
    expect(JSON.stringify(queued)).not.toContain(input.callerPhone);
    expect(queued?.metadata).toEqual({
      source: "GEMINI_FAST_SEMANTIC_BOUNDARY",
      raw_transcript_stored: false,
    });
  });

  it("does not mask direct persistence failure when no Gemini queue is bound", async () => {
    await expect(recordFastCallerSecuritySignalDurably(
      baseEnv,
      input,
      async () => new Response("unavailable", { status: 503 }),
    )).rejects.toThrow("HTTP 503");
  });

  it("falls back to direct idempotent persistence when Queue rejects", async () => {
    const queue = {
      async send() { throw new Error("queue unavailable"); },
    } as unknown as Queue<QueuedFastCallerSecuritySignal>;
    const fetcher = vi.fn(async () => Response.json([{ action: "ALLOW_FUTURE_CALLS" }]));
    const result = await recordFastCallerSecuritySignalDurably({
      ...baseEnv,
      GEMINI_CALLER_SECURITY_SIGNALS: queue,
    }, input, fetcher);
    expect(result.delivery).toBe("DIRECT");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
