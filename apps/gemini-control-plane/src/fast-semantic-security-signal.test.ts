import { describe, expect, it, vi } from "vitest";
import { routeFastSemanticSecuritySignal } from "./fast-semantic-security-signal";

const TOKEN = "0123456789abcdef0123456789abcdef";
const env = {
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN: TOKEN,
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-for-tests-only",
  CALLER_SECURITY_HMAC_SECRET: "shared-caller-identity-secret",
};
const validBody = {
  tenantId: "tenant-a",
  callerPhoneE164: "+34600000000",
  category: "PROMPT_INJECTION",
  eventKey: `gemini-fast-semsec-v1:${"a".repeat(64)}`,
};

function request(body: unknown, token = TOKEN) {
  return new Request("https://worker.example/internal/fast-semantic-security-signal", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Gemini Fast semantic security route", () => {
  it("rejects unauthorized calls before persistence", async () => {
    const recordSignal = vi.fn();
    const response = await routeFastSemanticSecuritySignal(request(validBody, "wrong"), env, { recordSignal });
    expect(response.status).toBe(401);
    expect(recordSignal).not.toHaveBeenCalled();
  });

  it("rejects unknown fields and malformed event keys", async () => {
    const recordSignal = vi.fn();
    for (const body of [{ ...validBody, transcript: "hostile raw text" }, { ...validBody, eventKey: "bad" }]) {
      const response = await routeFastSemanticSecuritySignal(request(body), env, { recordSignal });
      expect(response.status).toBe(400);
    }
    expect(recordSignal).not.toHaveBeenCalled();
  });

  it("fails visibly when the historical HMAC continuity key is absent", async () => {
    const recordSignal = vi.fn();
    const response = await routeFastSemanticSecuritySignal(request(validBody), {
      ...env,
      CALLER_SECURITY_HMAC_SECRET: undefined,
    }, { recordSignal });
    expect(response.status).toBe(503);
    expect(recordSignal).not.toHaveBeenCalled();
  });

  it("acknowledges only after a bounded metadata-only signal has a durable owner", async () => {
    const recordSignal = vi.fn(async (_env, signal) => {
      expect(signal).toEqual({
        eventKey: validBody.eventKey,
        tenantId: validBody.tenantId,
        callerPhone: validBody.callerPhoneE164,
        eventType: "GEMINI_SEMANTIC_PROMPT_INJECTION",
        severity: "MEDIUM",
        riskDelta: 1,
        highConfidence: false,
        metadata: {
          source: "GEMINI_FAST_SEMANTIC_BOUNDARY",
          category: "PROMPT_INJECTION",
          raw_transcript_stored: false,
        },
      });
      expect(JSON.stringify(signal.metadata)).not.toContain("hostile");
      return { delivery: "DIRECT" as const };
    });
    const response = await routeFastSemanticSecuritySignal(request(validBody), env, { recordSignal });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true, status: "SECURITY_SIGNAL_RECORDED" });
    expect(recordSignal).toHaveBeenCalledOnce();
  });

  it("returns queued only after the Queue handoff resolves", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const responsePromise = routeFastSemanticSecuritySignal(request(validBody), env, {
      recordSignal: async () => {
        await pending;
        return { delivery: "QUEUED" };
      },
    });
    let settled = false;
    void responsePromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    const response = await responsePromise;
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, status: "SECURITY_SIGNAL_QUEUED" });
  });

  it("returns a persistence failure when no lifecycle handoff or queue succeeds", async () => {
    const response = await routeFastSemanticSecuritySignal(request(validBody), env, {
      recordSignal: async () => { throw new Error("unavailable"); },
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ ok: false, status: "SECURITY_SIGNAL_PERSIST_FAILED" });
  });
});
