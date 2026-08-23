import test from "node:test";
import assert from "node:assert/strict";
import { registerGeminiMediaEdgeBootstrapForAdmittedSession } from "../.test-dist/gemini-media-edge-bootstrap-registration.js";
import { directAgentRealtimeBootstrapPolicy } from "../.test-dist/direct-agent-realtime-bootstrap.js";

const binding = Object.freeze({
  provider: "GEMINI",
  tenantId: "tenant-a",
  callControlId: "call-a",
  edgeUrl: "wss://media.example.test/telnyx/gemini",
  targetLegs: "self",
  notAfterEpochMs: 2_000_000_000_000,
});

test("registration sends canonical bootstrap and deferred activity policy outside stream credential", async () => {
  const calls = [];
  const context = { assistantName: "Lucía", businessName: "Casa A" };
  const canonical = directAgentRealtimeBootstrapPolicy(context);

  await registerGeminiMediaEdgeBootstrapForAdmittedSession({
    credentialId: "cred-a",
    binding,
    context,
    controlPlaneToken: "control-token-placeholder",
  }, async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 201 });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://media.example.test/internal/bootstrap");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.credentialId, "cred-a");
  assert.equal(body.tenantId, binding.tenantId);
  assert.equal(body.callControlId, binding.callControlId);
  assert.equal(body.notAfterEpochMs, binding.notAfterEpochMs);
  assert.equal(body.instructions, canonical.instructions);
  assert.deepEqual(body.tools, canonical.tools);
  assert.equal(body.manualActivityDetection, true);
  assert.equal(body.manualActivityHandling, "START_OF_ACTIVITY_INTERRUPTS");
  assert.equal(JSON.stringify(body).includes("control-token-placeholder"), false);
});

test("registration fails closed for wrong provider or registration failure", async () => {
  await assert.rejects(
    registerGeminiMediaEdgeBootstrapForAdmittedSession({
      credentialId: "cred-a",
      binding: { ...binding, provider: "OPENAI" },
      context: {},
      controlPlaneToken: "control-token-placeholder",
    }, async () => new Response("{}", { status: 201 })),
    /requires GEMINI affinity/,
  );

  await assert.rejects(
    registerGeminiMediaEdgeBootstrapForAdmittedSession({
      credentialId: "cred-a",
      binding,
      context: {},
      controlPlaneToken: "control-token-placeholder",
    }, async () => new Response("{}", { status: 503 })),
    /failed with HTTP 503/,
  );
});

test("registration transport errors are redacted", async () => {
  const secret = "control-token-placeholder";
  await assert.rejects(
    registerGeminiMediaEdgeBootstrapForAdmittedSession({
      credentialId: "cred-a",
      binding,
      context: {},
      controlPlaneToken: secret,
    }, async () => { throw new Error(`network error with ${secret}`); }),
    (error) => {
      assert.equal(error.message, "Gemini media edge bootstrap registration failed");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
