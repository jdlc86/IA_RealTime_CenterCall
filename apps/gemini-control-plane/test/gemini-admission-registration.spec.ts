import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GEMINI_ADMISSION_VERSION_V1, type GeminiAdmissionV1 } from "../src/admission/v1";
import { GEMINI_CONTROL_CAPABILITY_VERSION_V1 } from "../src/control-auth/capability-v1";

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

function controlRequest(value: GeminiAdmissionV1, credentialId = value.credentialId) {
  return new Request("https://do/internal/control", {
    headers: {
      Upgrade: "websocket",
      "x-gemini-control-authenticated": GEMINI_CONTROL_CAPABILITY_VERSION_V1,
      "x-gemini-tenant-id": value.tenantId,
      "x-gemini-call-control-id": value.callControlId,
      "x-gemini-call-session-id": value.callSessionId,
      "x-gemini-edge-session-id": value.edgeSessionId,
      "x-gemini-credential-id": credentialId,
      "x-gemini-capability-not-after": String(value.notAfterEpochMs),
    },
  });
}

describe("GeminiCallSession admission registration", () => {
  it("accepts an identical webhook retry idempotently", async () => {
    const stub = env.GEMINI_CALL_SESSIONS.getByName("call-session-admission");
    const value = admission();

    expect(await stub.registerAdmission(value)).toBe("CREATED");
    expect(await stub.registerAdmission(value)).toBe("IDEMPOTENT");
  });

  it("rejects immutable identity rebinding without throwing across RPC", async () => {
    const stub = env.GEMINI_CALL_SESSIONS.getByName("call-session-admission-rebind");
    const original = admission({ callSessionId: "call-session-admission-rebind" });
    expect(await stub.registerAdmission(original)).toBe("CREATED");
    expect(await stub.registerAdmission({
      ...original,
      edgeSessionId: "other-edge-session",
    })).toBe("REJECTED_IMMUTABLE");
  });

  it("rejects expired admission at the DO boundary without throwing across RPC", async () => {
    const stub = env.GEMINI_CALL_SESSIONS.getByName("call-session-admission-expired");
    expect(await stub.registerAdmission(admission({
      callSessionId: "call-session-admission-expired",
      notAfterEpochMs: Date.now() - 1,
    }))).toBe("REJECTED_EXPIRED");
  });

  it("requires admission before opening control and enforces all persisted identities", async () => {
    const callSessionId = "call-session-control-gate";
    const stub = env.GEMINI_CALL_SESSIONS.getByName(callSessionId);
    const value = admission({
      callSessionId,
      edgeSessionId: "edge-control-gate",
      credentialId: "credential-control-gate",
    });

    const beforeAdmission = await stub.fetch(controlRequest(value));
    expect(beforeAdmission.status).toBe(403);

    expect(await stub.registerAdmission(value)).toBe("CREATED");

    const wrongCredential = await stub.fetch(controlRequest(value, "wrong-credential"));
    expect(wrongCredential.status).toBe(403);

    const accepted = await stub.fetch(controlRequest(value));
    expect(accepted.status).toBe(101);
    accepted.webSocket?.accept();
    accepted.webSocket?.close(1000, "done");
  });
});
