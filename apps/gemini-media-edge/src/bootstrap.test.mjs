import test from "node:test";
import assert from "node:assert/strict";
import { buildGeminiInitialSetup, InMemoryBootstrapRegistry, isGeminiSetupComplete } from "./bootstrap.mjs";

const bootstrap = Object.freeze({
  credentialId: "cred-bootstrap-1",
  tenantId: "tenant-a",
  callControlId: "call-a",
  notAfterEpochMs: 2_000,
  instructions: "Eres Lucía.",
  tools: [{ type: "function", name: "restaurant_conversation", description: "Conversación", parameters: { type: "object", properties: {}, additionalProperties: false } }],
});

const claims = Object.freeze({
  credentialId: "cred-bootstrap-1",
  tenantId: "tenant-a",
  callControlId: "call-a",
  notAfterEpochMs: 2_000,
});

test("immutable setup carries system instruction, tools and manual activity configuration", () => {
  assert.deepEqual(buildGeminiInitialSetup(bootstrap, "gemini-live-model"), {
    setup: {
      model: "gemini-live-model",
      systemInstruction: { parts: [{ text: "Eres Lucía." }] },
      tools: [{ functionDeclarations: [{ name: "restaurant_conversation", description: "Conversación", parameters: { type: "object", properties: {}, additionalProperties: false } }] }],
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
        activityHandling: "NO_INTERRUPTION",
      },
    },
  });
});

test("bootstrap registry binds policy to exact credential, tenant, call and expiry and consumes once", () => {
  const registry = new InMemoryBootstrapRegistry();
  registry.register(bootstrap, 1_000);
  assert.equal(registry.size(), 1);
  assert.deepEqual(registry.consumeForClaims(claims, 1_500), bootstrap);
  assert.equal(registry.size(), 0);
  assert.throws(() => registry.consumeForClaims(claims, 1_501), /not registered/);
});

test("wrong call cannot consume registered bootstrap", () => {
  const registry = new InMemoryBootstrapRegistry();
  registry.register(bootstrap, 1_000);
  assert.throws(() => registry.consumeForClaims({ ...claims, callControlId: "call-b" }, 1_500), /identity does not match/);
  assert.equal(registry.size(), 1);
  assert.deepEqual(registry.consumeForClaims(claims, 1_500), bootstrap);
});

test("expired bootstrap is pruned and cannot authorize setup", () => {
  const registry = new InMemoryBootstrapRegistry();
  registry.register(bootstrap, 1_000);
  assert.throws(() => registry.consumeForClaims(claims, 2_000), /not registered/);
  assert.equal(registry.size(), 0);
});

test("setupComplete recognition is identity-based and does not infer readiness from other server events", () => {
  assert.equal(isGeminiSetupComplete({ setupComplete: {} }), true);
  assert.equal(isGeminiSetupComplete({ setup_complete: {} }), true);
  assert.equal(isGeminiSetupComplete({ serverContent: { generationComplete: true } }), false);
  assert.equal(isGeminiSetupComplete({}), false);
});
