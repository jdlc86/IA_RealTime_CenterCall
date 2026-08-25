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
  manualActivityDetection: true,
  manualActivityHandling: "START_OF_ACTIVITY_INTERRUPTS",
});

const claims = Object.freeze({
  credentialId: "cred-bootstrap-1",
  tenantId: "tenant-a",
  callControlId: "call-a",
  notAfterEpochMs: 2_000,
});

test("immutable setup carries system instruction, blocking tools and deferred manual activity configuration", () => {
  assert.deepEqual(buildGeminiInitialSetup(bootstrap, "gemini-live-model"), {
    setup: {
      model: "models/gemini-live-model",
      systemInstruction: { parts: [{ text: "Eres Lucía." }] },
      tools: [{ functionDeclarations: [{ name: "restaurant_conversation", description: "Conversación", behavior: "BLOCKING", parametersJsonSchema: { type: "object", properties: {}, additionalProperties: false } }] }],
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
    },
  });
});

test("Gemini-only reservation declaration preserves the OpenAI progressive backend contract", () => {
  const originalDescription = "Crea o continúa una reserva multivuelta cuando el cliente ha elegido una fecha y hora concretas. Úsala también para recopilar progresivamente los demás datos; el backend indicará qué falta.";
  const setup = buildGeminiInitialSetup({
    ...bootstrap,
    tools: [{
      type: "function",
      name: "restaurant_reservation_create",
      description: originalDescription,
      parameters: { type: "object", properties: { starts_at: { type: "string" } }, additionalProperties: false },
    }],
  }, "gemini-live-model");
  const declaration = setup.setup.tools[0].functionDeclarations[0];
  assert.equal(declaration.description.startsWith(originalDescription), true);
  assert.equal(declaration.description.includes("progressive multi-turn operation"), true);
  assert.equal(declaration.description.includes("as soon as the caller starts or continues a reservation"), true);
  assert.equal(declaration.description.includes("backend reports missing information"), true);
  assert.equal(declaration.behavior, "BLOCKING");
  assert.equal(bootstrap.tools[0].description, "Conversación");
});

test("bootstrap rejects activity policies that would bypass deferred semantic authorization", () => {
  assert.throws(() => buildGeminiInitialSetup({ ...bootstrap, manualActivityHandling: "NO_INTERRUPTION" }, "gemini-live-model"), /START_OF_ACTIVITY_INTERRUPTS/);
  assert.throws(() => buildGeminiInitialSetup({ ...bootstrap, manualActivityDetection: false }, "gemini-live-model"), /manual activity detection/);
});

test("bootstrap registry binds policy to exact credential, tenant, call and expiry and consumes once", () => {
  const registry = new InMemoryBootstrapRegistry();
  registry.register(bootstrap, 1_000);
  assert.equal(registry.size(), 1);
  assert.deepEqual(registry.consumeForClaims(claims, 1_500), bootstrap);
  assert.equal(registry.size(), 0);
  assert.throws(() => registry.consumeForClaims(claims, 1_501), /not registered/);
});

test("immutable setup uses the Gemini WebSocket model resource contract exactly once", () => {
  assert.equal(buildGeminiInitialSetup(bootstrap, "gemini-live-model").setup.model, "models/gemini-live-model");
  assert.equal(buildGeminiInitialSetup(bootstrap, "models/gemini-live-model").setup.model, "models/gemini-live-model");
  assert.throws(() => buildGeminiInitialSetup(bootstrap, "publishers/google/models/gemini-live-model"), /resource name is invalid/);
});

test("tool declarations use Gemini JSON schema without unsupported uniqueness hints", () => {
  const setup = buildGeminiInitialSetup({
    ...bootstrap,
    tools: [{
      type: "function",
      name: "restaurant_business_info",
      description: "Consulta datos",
      parameters: {
        type: "object",
        properties: {
          topics: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            items: { type: "string", enum: ["HOURS", "LOCATION"] },
          },
        },
        required: ["topics"],
        additionalProperties: false,
      },
    }],
  }, "gemini-live-model");
  const declaration = setup.setup.tools[0].functionDeclarations[0];
  assert.equal("parameters" in declaration, false);
  assert.equal(declaration.behavior, "BLOCKING");
  assert.deepEqual(declaration.parametersJsonSchema, {
    type: "object",
    properties: {
      topics: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string", enum: ["HOURS", "LOCATION"] },
      },
    },
    required: ["topics"],
    additionalProperties: false,
  });
});

test("an identical webhook retry may register the same bootstrap idempotently", () => {
  const registry = new InMemoryBootstrapRegistry();
  const first = registry.register(bootstrap, 1_000);
  const second = registry.register(structuredClone(bootstrap), 1_001);
  assert.equal(second, first);
  assert.equal(registry.size(), 1);
  assert.throws(
    () => registry.register({ ...bootstrap, instructions: "Different policy" }, 1_002),
    /different content/,
  );
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
