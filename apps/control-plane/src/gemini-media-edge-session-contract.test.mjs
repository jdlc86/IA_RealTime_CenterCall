import test from "node:test";
import assert from "node:assert/strict";
import {
  createGeminiMediaEdgeSessionContract,
  geminiMediaEdgeAuditView,
  geminiMediaEdgeTelnyxStartRequest,
} from "../.test-dist/gemini-media-edge-session-contract.js";

function validInput(overrides = {}) {
  return {
    provider: "GEMINI",
    tenantId: "tenant-madrid",
    callControlId: "call-123",
    edgeUrl: "wss://media.example.test/telnyx/gemini",
    streamAuthToken: "opaque-edge-token-123",
    targetLegs: "self",
    notAfterEpochMs: 1_800_000_000_000,
    ...overrides,
  };
}

test("Gemini media edge contract binds tenant, call and immutable GEMINI affinity without side effects", () => {
  const contract = createGeminiMediaEdgeSessionContract(validInput());

  assert.deepEqual(contract.binding, {
    provider: "GEMINI",
    tenantId: "tenant-madrid",
    callControlId: "call-123",
    edgeUrl: "wss://media.example.test/telnyx/gemini",
    targetLegs: "self",
    notAfterEpochMs: 1_800_000_000_000,
  });
  assert.equal(contract.secret.streamAuthToken, "opaque-edge-token-123");
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.binding), true);
  assert.equal(Object.isFrozen(contract.secret), true);
});

test("audit view never serializes the stream authentication token", () => {
  const token = "never-log-this-token";
  const contract = createGeminiMediaEdgeSessionContract(validInput({ streamAuthToken: token }));
  const audit = geminiMediaEdgeAuditView(contract);
  const serialized = JSON.stringify(audit);

  assert.deepEqual(audit, {
    provider: "GEMINI",
    tenantId: "tenant-madrid",
    callControlId: "call-123",
    edgeOrigin: "wss://media.example.test",
    targetLegs: "self",
    notAfterEpochMs: 1_800_000_000_000,
    streamAuth: "PRESENT",
  });
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes("streamAuthToken"), false);
});

test("session contract rejects provider drift, insecure edge URLs and URL credential leakage", () => {
  assert.throws(
    () => createGeminiMediaEdgeSessionContract(validInput({ provider: "OPENAI" })),
    /provider affinity must be GEMINI/,
  );
  assert.throws(
    () => createGeminiMediaEdgeSessionContract(validInput({ edgeUrl: "ws://media.example.test/telnyx/gemini" })),
    /must use wss:\/\//,
  );
  assert.throws(
    () => createGeminiMediaEdgeSessionContract(validInput({ edgeUrl: "wss://user:pass@media.example.test/telnyx/gemini" })),
    /must not contain credentials/,
  );
});

test("session contract rejects a stream token embedded in the WSS URL", () => {
  const token = "edge-secret-token";
  assert.throws(
    () => createGeminiMediaEdgeSessionContract(validInput({
      streamAuthToken: token,
      edgeUrl: `wss://media.example.test/telnyx/gemini?token=${token}`,
    })),
    /token must not be embedded in the URL/,
  );
});

test("expiry is authoritative input and invalid temporal claims fail closed without using local time", () => {
  assert.throws(
    () => createGeminiMediaEdgeSessionContract(validInput({ notAfterEpochMs: 0 })),
    /positive safe integer/,
  );
  assert.throws(
    () => createGeminiMediaEdgeSessionContract(validInput({ notAfterEpochMs: Number.MAX_SAFE_INTEGER + 1 })),
    /positive safe integer/,
  );
});

test("pure Telnyx adapter carries the exact bound secret but does not execute streaming_start", () => {
  const contract = createGeminiMediaEdgeSessionContract(validInput({ targetLegs: "both" }));
  const request = geminiMediaEdgeTelnyxStartRequest(contract, "stream-start-123", "client-state");

  assert.deepEqual(request, {
    callControlId: "call-123",
    streamUrl: "wss://media.example.test/telnyx/gemini",
    streamAuthToken: "opaque-edge-token-123",
    targetLegs: "both",
    commandId: "stream-start-123",
    clientState: "client-state",
  });
  assert.equal(Object.isFrozen(request), true);
});

test("invalid tenant, call, target legs or command identity fail closed", () => {
  assert.throws(() => createGeminiMediaEdgeSessionContract(validInput({ tenantId: " " })), /tenant_id is required/);
  assert.throws(() => createGeminiMediaEdgeSessionContract(validInput({ callControlId: "" })), /call_control_id is required/);
  assert.throws(() => createGeminiMediaEdgeSessionContract(validInput({ targetLegs: "caller" })), /target legs are invalid/);

  const contract = createGeminiMediaEdgeSessionContract(validInput());
  assert.throws(() => geminiMediaEdgeTelnyxStartRequest(contract, " "), /streaming command_id is required/);
});
