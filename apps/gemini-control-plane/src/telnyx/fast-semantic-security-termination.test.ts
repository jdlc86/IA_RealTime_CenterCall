import { describe, expect, it, vi } from "vitest";
import { routeFastSemanticSecurityTermination } from "./fast-semantic-security-termination";

const TOKEN = "0123456789abcdef0123456789abcdef";
const EVENT_KEY = `gemini-fast-semsec-terminal-v1:${"a".repeat(64)}`;

function env(routeTenant = "tenant-a") {
  return {
    GEMINI_MEDIA_CONTROL_PLANE_TOKEN: TOKEN,
    TELNYX_API_KEY: "telnyx-test-key",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    CALLER_SECURITY_HMAC_SECRET: "caller-security-secret-with-32-bytes",
    TENANT_ROUTING_KV: {
      get: vi.fn(async () => JSON.stringify({ enabled: true, tenant_id: routeTenant })),
    },
  };
}

function request(overrides: Record<string, unknown> = {}, token = TOKEN) {
  return new Request("https://worker.example/internal/call-security/terminate", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      tenantId: "tenant-a",
      callControlId: "v3:opaque-call",
      calledPhoneE164: "+34910000001",
      callerPhoneE164: "+34600000000",
      category: "TOOL_MANIPULATION",
      eventKey: EVENT_KEY,
      ...overrides,
    }),
  });
}

describe("Fast semantic security termination", () => {
  it("records high-confidence reputation and hangs up through Telnyx", async () => {
    const recordSignal = vi.fn(async () => ({ delivery: "QUEUED" as const }));
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    const response = await routeFastSemanticSecurityTermination(request(), env(), { recordSignal, fetcher });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, status: "SECURITY_CALL_TERMINATED", reputationSignalStatus: "QUEUED" });
    expect(recordSignal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventKey: EVENT_KEY,
      severity: "HIGH",
      riskDelta: 10,
      highConfidence: true,
    }));
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/calls/v3%3Aopaque-call/actions/hangup",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    expect(JSON.parse(String(init?.body))).toEqual({ command_id: `gemini-semsec-close-${"a".repeat(32)}` });
  });

  it("still executes the terminal effect when reputation persistence is unavailable", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
    const response = await routeFastSemanticSecurityTermination(request(), env(), {
      recordSignal: vi.fn(async () => { throw new Error("queue unavailable"); }),
      fetcher,
    });
    expect(response.status).toBe(202);
    expect(fetcher).toHaveBeenCalledOnce();
    const body = await response.json() as { reputationSignalStatus: string };
    expect(body.reputationSignalStatus).toBe("UNAVAILABLE");
  });

  it("does not put reputation persistence in front of the Telnyx terminal effect", async () => {
    let releaseSignal!: () => void;
    const pendingSignal = new Promise<{ delivery: "QUEUED" }>((resolve) => {
      releaseSignal = () => resolve({ delivery: "QUEUED" });
    });
    const scheduled: Promise<void>[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    const response = await routeFastSemanticSecurityTermination(request(), env(), {
      recordSignal: vi.fn(async () => pendingSignal),
      fetcher,
      waitUntil: (promise) => scheduled.push(promise),
    });
    expect(response.status).toBe(202);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
    const body = await response.json() as { reputationSignalStatus: string };
    expect(body.reputationSignalStatus).toBe("SCHEDULED");
    releaseSignal();
    await scheduled[0];
  });

  it("fails closed before Telnyx on unauthorized, cross-tenant or extra-field input", async () => {
    const fetcher = vi.fn();
    expect((await routeFastSemanticSecurityTermination(request({}, "wrong"), env(), { fetcher })).status).toBe(401);
    expect((await routeFastSemanticSecurityTermination(request(), env("tenant-b"), { fetcher })).status).toBe(403);
    expect((await routeFastSemanticSecurityTermination(request({ transcript: "must-not-cross" }), env(), { fetcher })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports Telnyx failure without claiming termination", async () => {
    const response = await routeFastSemanticSecurityTermination(request(), env(), {
      recordSignal: vi.fn(async () => ({ delivery: "DIRECT" as const })),
      fetcher: vi.fn(async () => new Response(null, { status: 500 })),
    });
    expect(response.status).toBe(502);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("SECURITY_TERMINATION_FAILED");
  });
});
