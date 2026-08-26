import { describe, expect, it } from "vitest";
import {
  assertGeminiAdmissionBindingV1,
  GEMINI_ADMISSION_VERSION_V1,
  parseGeminiAdmissionV1,
} from "./v1";

const NOW = 1_787_740_000_000;
const MAX_TTL_MS = 120_000;

function validAdmission(overrides: Record<string, unknown> = {}) {
  return {
    version: GEMINI_ADMISSION_VERSION_V1,
    provider: "GEMINI",
    tenantId: "tenant-1",
    callControlId: "call-control-1",
    callSessionId: "call-session-1",
    edgeSessionId: "edge-session-1",
    credentialId: "credential-1",
    notAfterEpochMs: NOW + 60_000,
    ...overrides,
  };
}

describe("Gemini admission v1", () => {
  it("binds tenant, call, session, edge and credential identity", () => {
    const admission = parseGeminiAdmissionV1(validAdmission(), {
      nowEpochMs: NOW,
      maxTtlMs: MAX_TTL_MS,
    });

    expect(admission).toEqual(validAdmission());
    expect(() => assertGeminiAdmissionBindingV1(admission, {
      tenantId: "tenant-1",
      callControlId: "call-control-1",
      callSessionId: "call-session-1",
      edgeSessionId: "edge-session-1",
      credentialId: "credential-1",
    })).not.toThrow();
  });

  it("fails closed on provider/version or identity mismatch", () => {
    expect(() => parseGeminiAdmissionV1(validAdmission({ provider: "OPENAI" }), {
      nowEpochMs: NOW,
      maxTtlMs: MAX_TTL_MS,
    })).toThrow(/provider/i);

    expect(() => parseGeminiAdmissionV1(validAdmission({ version: "gemini-admission.v2" }), {
      nowEpochMs: NOW,
      maxTtlMs: MAX_TTL_MS,
    })).toThrow(/version/i);

    const admission = parseGeminiAdmissionV1(validAdmission(), {
      nowEpochMs: NOW,
      maxTtlMs: MAX_TTL_MS,
    });
    expect(() => assertGeminiAdmissionBindingV1(admission, { edgeSessionId: "other-edge" })).toThrow(/binding mismatch/i);
  });

  it("rejects expired and overlong admissions", () => {
    expect(() => parseGeminiAdmissionV1(validAdmission({ notAfterEpochMs: NOW }), {
      nowEpochMs: NOW,
      maxTtlMs: MAX_TTL_MS,
    })).toThrow(/expired/i);

    expect(() => parseGeminiAdmissionV1(validAdmission({ notAfterEpochMs: NOW + MAX_TTL_MS + 1 }), {
      nowEpochMs: NOW,
      maxTtlMs: MAX_TTL_MS,
    })).toThrow(/TTL/i);
  });

  it("rejects missing or malformed immutable identities", () => {
    for (const field of ["tenantId", "callControlId", "callSessionId", "edgeSessionId", "credentialId"]) {
      expect(() => parseGeminiAdmissionV1(validAdmission({ [field]: "" }), {
        nowEpochMs: NOW,
        maxTtlMs: MAX_TTL_MS,
      })).toThrow();
    }
    expect(() => parseGeminiAdmissionV1(validAdmission({ callSessionId: "bad\nidentity" }), {
      nowEpochMs: NOW,
      maxTtlMs: MAX_TTL_MS,
    })).toThrow(/invalid/i);
  });
});
