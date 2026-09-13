import { describe, expect, it } from "vitest";
import { issueGeminiAdmissionIdentity } from "./identity-issuer";

const SECRET = "0123456789abcdef0123456789abcdef";

function input(overrides: Record<string, string> = {}) {
  return {
    tenantId: "tenant-1",
    telnyxEventId: "evt-1",
    callControlId: "v3:call-control-1",
    secret: SECRET,
    ...overrides,
  };
}

describe("Gemini admission identity issuer", () => {
  it("is stable across webhook retries and domain-separates every identity", async () => {
    const first = await issueGeminiAdmissionIdentity(input());
    const retry = await issueGeminiAdmissionIdentity(input());
    expect(retry).toEqual(first);
    expect(first.callSessionId).toMatch(/^cs_[A-Za-z0-9_-]+$/);
    expect(first.edgeSessionId).toMatch(/^edge_[A-Za-z0-9_-]+$/);
    expect(first.credentialId).toMatch(/^cred_[A-Za-z0-9_-]+$/);
    expect(new Set([first.callSessionId, first.edgeSessionId, first.credentialId]).size).toBe(3);
  });

  it("changes all derived identities when signed event, call or tenant identity changes", async () => {
    const base = await issueGeminiAdmissionIdentity(input());
    for (const changed of [
      input({ telnyxEventId: "evt-2" }),
      input({ callControlId: "v3:call-control-2" }),
      input({ tenantId: "tenant-2" }),
    ]) {
      const next = await issueGeminiAdmissionIdentity(changed);
      expect(next.callSessionId).not.toBe(base.callSessionId);
      expect(next.edgeSessionId).not.toBe(base.edgeSessionId);
      expect(next.credentialId).not.toBe(base.credentialId);
    }
  });

  it("rejects weak or malformed secret and identity inputs", async () => {
    await expect(issueGeminiAdmissionIdentity(input({ secret: "too-short" }))).rejects.toThrow(/at least 32 bytes/i);
    await expect(issueGeminiAdmissionIdentity(input({ tenantId: "" }))).rejects.toThrow(/tenantId/i);
    await expect(issueGeminiAdmissionIdentity(input({ telnyxEventId: "bad\nevent" }))).rejects.toThrow(/invalid/i);
  });
});
