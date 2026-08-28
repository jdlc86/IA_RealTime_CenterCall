import { describe, expect, it } from "vitest";
import { routeFastSecuritySignal, type FastSecuritySignalEnv } from "./fast-security-signal";

const ENV: FastSecuritySignalEnv = {
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN: "0123456789abcdef0123456789abcdef",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-secret-0123456789",
};

const BODY = {
  tenantId: "tenant-test",
  callControlId: "opaque-call-id",
  callerPhoneE164: "+34600000000",
  toolCallId: "tool-semsec-1",
  category: "PROMPT_INJECTION",
};

function request(body: unknown = BODY, token = ENV.GEMINI_MEDIA_CONTROL_PLANE_TOKEN) {
  return new Request("https://worker.example/internal/security-signal", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Fast security signal route", () => {
  it("records one low-impact idempotent semantic reputation signal without persisting phone or transcript", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const response = await routeFastSecuritySignal(request(), ENV, {
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify([{
          action: "ALLOW_FUTURE_CALLS",
          blocked_until: null,
          permanent_block: false,
          risk_score: 1,
          security_strikes: 0,
          reason: "GEMINI_SEMANTIC_PROMPT_INJECTION",
        }]), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, status: "SECURITY_SIGNAL_RECORDED" });
    expect(calls).toHaveLength(1);
    const rpc = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(rpc.p_tenant_id).toBe("tenant-test");
    expect(rpc.p_event_type).toBe("GEMINI_SEMANTIC_PROMPT_INJECTION");
    expect(rpc.p_severity).toBe("MEDIUM");
    expect(rpc.p_risk_delta).toBe(1);
    expect(rpc.p_high_confidence).toBe(false);
    expect(String(rpc.p_event_key)).toMatch(/^gemini-fast-semsec-v1:[a-f0-9]{64}$/);
    expect(String(rpc.p_caller_key)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rpc)).not.toContain(BODY.callerPhoneE164);
    expect(rpc).not.toHaveProperty("transcript");
    expect(rpc).not.toHaveProperty("p_transcript");
    expect(rpc.p_metadata).toEqual({
      source: "GEMINI_FAST_SEMANTIC_BOUNDARY",
      category: "PROMPT_INJECTION",
      raw_transcript_stored: false,
    });
    expect(rpc.p_metadata as Record<string, unknown>).not.toHaveProperty("transcript");
  });

  it("derives the same event key for a retry of the same tool call", async () => {
    const eventKeys: string[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      eventKeys.push((JSON.parse(String(init?.body)) as { p_event_key: string }).p_event_key);
      return new Response("[]", { status: 200 });
    };
    await routeFastSecuritySignal(request(), ENV, { fetcher });
    await routeFastSecuritySignal(request(), ENV, { fetcher });
    expect(eventKeys).toHaveLength(2);
    expect(eventKeys[0]).toBe(eventKeys[1]);
  });

  it("rejects unauthorized, malformed, extra-field and unknown-category requests before Supabase", async () => {
    let called = false;
    const fetcher = async () => { called = true; return new Response("[]", { status: 200 }); };
    expect((await routeFastSecuritySignal(request(BODY, "wrong"), ENV, { fetcher })).status).toBe(401);
    expect((await routeFastSecuritySignal(request({ ...BODY, transcript: "never persist" }), ENV, { fetcher })).status).toBe(400);
    expect((await routeFastSecuritySignal(request({ ...BODY, category: "UNKNOWN" }), ENV, { fetcher })).status).toBe(400);
    expect(called).toBe(false);
  });
});
