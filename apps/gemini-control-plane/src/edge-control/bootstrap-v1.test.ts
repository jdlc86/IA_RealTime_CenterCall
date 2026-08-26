import { describe, expect, it } from "vitest";
import { GEMINI_ADMISSION_VERSION_V1 } from "../admission/v1";
import {
  buildGeminiEdgeControlBootstrapV1,
  GEMINI_EDGE_CONTROL_BOOTSTRAP_VERSION_V1,
  publicGeminiEdgeControlBootstrapAuditV1,
} from "./bootstrap-v1";

const NOW = 1_787_745_000_000;
const admission = {
  version: GEMINI_ADMISSION_VERSION_V1,
  provider: "GEMINI" as const,
  tenantId: "tenant-edge-bootstrap",
  callControlId: "call-control-edge-bootstrap",
  callSessionId: "call-session-edge-bootstrap",
  edgeSessionId: "edge-session-bootstrap",
  credentialId: "credential-edge-bootstrap",
  notAfterEpochMs: NOW + 60_000,
};

describe("Gemini edge control bootstrap v1", () => {
  it("binds admission identity to a secret-free WSS URL and opaque capability", () => {
    const value = buildGeminiEdgeControlBootstrapV1(admission, {
      controlUrl: "wss://gemini-control.example.test/internal/control",
      controlCapability: "opaque-capability-token",
      nowEpochMs: NOW,
    });
    expect(value.version).toBe(GEMINI_EDGE_CONTROL_BOOTSTRAP_VERSION_V1);
    expect(value.callSessionId).toBe(admission.callSessionId);
    expect(value.edgeSessionId).toBe(admission.edgeSessionId);
    expect(value.credentialId).toBe(admission.credentialId);
    expect(value.notAfterEpochMs).toBe(admission.notAfterEpochMs);
    expect(value.controlUrl).toBe("wss://gemini-control.example.test/internal/control");
  });

  it("rejects query identity, non-WSS URLs, wrong path and expired admission", () => {
    expect(() => buildGeminiEdgeControlBootstrapV1(admission, {
      controlUrl: "wss://gemini-control.example.test/internal/control?credential_id=leak",
      controlCapability: "opaque",
      nowEpochMs: NOW,
    })).toThrow(/query identity/);
    expect(() => buildGeminiEdgeControlBootstrapV1(admission, {
      controlUrl: "https://gemini-control.example.test/internal/control",
      controlCapability: "opaque",
      nowEpochMs: NOW,
    })).toThrow(/wss:\/\//);
    expect(() => buildGeminiEdgeControlBootstrapV1(admission, {
      controlUrl: "wss://gemini-control.example.test/wrong",
      controlCapability: "opaque",
      nowEpochMs: NOW,
    })).toThrow(/path/);
    expect(() => buildGeminiEdgeControlBootstrapV1({ ...admission, notAfterEpochMs: NOW }, {
      controlUrl: "wss://gemini-control.example.test/internal/control",
      controlCapability: "opaque",
      nowEpochMs: NOW,
    })).toThrow(/expired/);
  });

  it("never includes the bearer capability in its audit view", () => {
    const value = buildGeminiEdgeControlBootstrapV1(admission, {
      controlUrl: "wss://gemini-control.example.test/internal/control",
      controlCapability: "secret-capability-material",
      nowEpochMs: NOW,
    });
    const audit = publicGeminiEdgeControlBootstrapAuditV1(value);
    expect(audit.controlCapabilityPresent).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("secret-capability-material");
  });
});
