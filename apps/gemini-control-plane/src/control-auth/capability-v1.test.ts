import { describe, expect, it } from "vitest";
import {
  bearerTokenFromRequest,
  GEMINI_CONTROL_CAPABILITY_VERSION_V1,
  issueGeminiControlCapabilityV1,
  verifyGeminiControlCapabilityV1,
  type GeminiControlCapabilityClaimsV1,
} from "./capability-v1";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = 1_787_745_000_000;

function claims(overrides: Partial<GeminiControlCapabilityClaimsV1> = {}): GeminiControlCapabilityClaimsV1 {
  return {
    version: GEMINI_CONTROL_CAPABILITY_VERSION_V1,
    provider: "GEMINI",
    tenantId: "tenant-cap",
    callControlId: "call-control-cap",
    callSessionId: "call-session-cap",
    edgeSessionId: "edge-session-cap",
    credentialId: "credential-cap",
    notAfterEpochMs: NOW + 60_000,
    ...overrides,
  };
}

describe("Gemini control capability v1", () => {
  it("round-trips all immutable admission bindings", async () => {
    const token = await issueGeminiControlCapabilityV1(claims(), SECRET);
    await expect(verifyGeminiControlCapabilityV1(token, SECRET, NOW)).resolves.toEqual(claims());
    expect(token).not.toContain("tenant-cap");
    expect(token).not.toContain("call-control-cap");
  });

  it("fails closed on tampering, expiry and wrong secret", async () => {
    const token = await issueGeminiControlCapabilityV1(claims(), SECRET);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
    await expect(verifyGeminiControlCapabilityV1(tampered, SECRET, NOW)).resolves.toBeNull();
    await expect(verifyGeminiControlCapabilityV1(token, "fedcba9876543210fedcba9876543210", NOW)).resolves.toBeNull();
    await expect(verifyGeminiControlCapabilityV1(token, SECRET, NOW + 60_000)).resolves.toBeNull();
  });

  it("requires a strong signing secret", async () => {
    await expect(issueGeminiControlCapabilityV1(claims(), "short-secret")).rejects.toThrow(/at least 32 bytes/i);
  });

  it("extracts only a single bearer token from Authorization", () => {
    expect(bearerTokenFromRequest(new Request("https://worker", {
      headers: { Authorization: "Bearer abc.def.ghi" },
    }))).toBe("abc.def.ghi");
    expect(bearerTokenFromRequest(new Request("https://worker", {
      headers: { Authorization: "Basic abc" },
    }))).toBeNull();
    expect(bearerTokenFromRequest(new Request("https://worker"))).toBeNull();
  });
});
