import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerGeminiAdmission } from "../src/admission/runtime";
import { GEMINI_ADMISSION_VERSION_V1 } from "../src/admission/v1";

const NOW = Date.now();
const MAX_TTL_MS = 120_000;

function value(overrides: Record<string, unknown> = {}) {
  return {
    version: GEMINI_ADMISSION_VERSION_V1,
    provider: "GEMINI",
    tenantId: "runtime-tenant",
    callControlId: "runtime-call-control",
    callSessionId: "runtime-call-session",
    edgeSessionId: "runtime-edge-session",
    credentialId: "runtime-credential",
    notAfterEpochMs: NOW + 60_000,
    ...overrides,
  };
}

describe("Gemini admission runtime composition", () => {
  it("parses and registers admission in the named call-session DO", async () => {
    const first = await registerGeminiAdmission(env, value(), {
      nowEpochMs: NOW,
      maxTtlMs: MAX_TTL_MS,
    });
    expect(first.registration).toBe("CREATED");
    expect(first.admission.callSessionId).toBe("runtime-call-session");

    const retry = await registerGeminiAdmission(env, value(), {
      nowEpochMs: NOW,
      maxTtlMs: MAX_TTL_MS,
    });
    expect(retry.registration).toBe("IDEMPOTENT");
  });

  it("fails before touching a DO when admission parsing fails", async () => {
    await expect(registerGeminiAdmission(env, value({ provider: "OPENAI" }), {
      nowEpochMs: NOW,
      maxTtlMs: MAX_TTL_MS,
    })).rejects.toThrow(/provider/i);
  });
});
