import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GEMINI_ADMISSION_VERSION_V1, type GeminiAdmissionV1 } from "../src/admission/v1";

function admission(overrides: Partial<GeminiAdmissionV1> = {}): GeminiAdmissionV1 {
  return {
    version: GEMINI_ADMISSION_VERSION_V1,
    provider: "GEMINI",
    tenantId: "tenant-admission",
    callControlId: "call-control-admission",
    callSessionId: "call-session-admission",
    edgeSessionId: "edge-session-admission",
    credentialId: "credential-admission",
    notAfterEpochMs: Date.now() + 60_000,
    ...overrides,
  };
}

describe("GeminiCallSession admission registration", () => {
  it("accepts an identical webhook retry idempotently", async () => {
    const stub = env.GEMINI_CALL_SESSIONS.getByName("call-session-admission");
    const value = admission();

    expect(await stub.registerAdmission(value)).toBe("CREATED");
    expect(await stub.registerAdmission(value)).toBe("IDEMPOTENT");
  });

  it("rejects immutable identity rebinding", async () => {
    const stub = env.GEMINI_CALL_SESSIONS.getByName("call-session-admission-rebind");
    const original = admission({ callSessionId: "call-session-admission-rebind" });
    expect(await stub.registerAdmission(original)).toBe("CREATED");

    await expect(stub.registerAdmission({
      ...original,
      edgeSessionId: "other-edge-session",
    })).rejects.toThrow(/immutable/i);
  });

  it("rejects expired admission at the DO boundary", async () => {
    const stub = env.GEMINI_CALL_SESSIONS.getByName("call-session-admission-expired");
    await expect(stub.registerAdmission(admission({
      callSessionId: "call-session-admission-expired",
      notAfterEpochMs: Date.now() - 1,
    }))).rejects.toThrow(/expired/i);
  });
});
