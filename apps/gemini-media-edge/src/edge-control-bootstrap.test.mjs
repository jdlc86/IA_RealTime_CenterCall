import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalEdgeControlBootstrap,
  controlWebSocketConnectionV1,
  edgeControlBootstrapAudit,
} from "./edge-control-bootstrap.mjs";

const NOW = 1_787_745_000_000;
const value = Object.freeze({
  version: "gemini-edge-control-bootstrap.v1",
  provider: "GEMINI",
  tenantId: "tenant-edge",
  callControlId: "call-control-edge",
  callSessionId: "call-session-edge",
  edgeSessionId: "edge-session-edge",
  credentialId: "credential-edge",
  controlUrl: "wss://gemini-control.example.test/internal/control",
  controlCapability: "opaque-control-capability",
  notAfterEpochMs: NOW + 60_000,
});

test("canonical edge control bootstrap keeps capability in memory and identity out of URL", () => {
  const bootstrap = canonicalEdgeControlBootstrap(value, NOW);
  assert.equal(bootstrap.controlUrl, "wss://gemini-control.example.test/internal/control");
  assert.equal(bootstrap.controlCapability, "opaque-control-capability");
  assert.equal(new URL(bootstrap.controlUrl).search, "");
});

test("control websocket config sends capability only through Authorization", () => {
  const connection = controlWebSocketConnectionV1(value, NOW);
  assert.equal(connection.url, "wss://gemini-control.example.test/internal/control");
  assert.deepEqual(connection.options.headers, {
    Authorization: "Bearer opaque-control-capability",
  });
  assert.equal(JSON.stringify(connection.url).includes("opaque-control-capability"), false);
});

test("audit view never contains capability material", () => {
  const audit = edgeControlBootstrapAudit(value, NOW);
  assert.equal(audit.controlCapabilityPresent, true);
  assert.equal(JSON.stringify(audit).includes("opaque-control-capability"), false);
});

test("invalid URLs and expired bootstrap fail closed", () => {
  assert.throws(() => canonicalEdgeControlBootstrap({
    ...value,
    controlUrl: "wss://gemini-control.example.test/internal/control?credential_id=leak",
  }, NOW), /forbidden/);
  assert.throws(() => canonicalEdgeControlBootstrap({
    ...value,
    controlUrl: "https://gemini-control.example.test/internal/control",
  }, NOW), /wss:\/\//);
  assert.throws(() => canonicalEdgeControlBootstrap({
    ...value,
    notAfterEpochMs: NOW,
  }, NOW), /expired/);
});
