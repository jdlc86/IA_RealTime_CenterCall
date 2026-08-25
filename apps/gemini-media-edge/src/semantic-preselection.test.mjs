import assert from "node:assert/strict";
import test from "node:test";
import { GeminiSemanticToolGate } from "./semantic-tool-gate.mjs";
import {
  buildSemanticPreselectionRequest,
  parseSemanticPreselection,
  resolveSemanticPreselection,
} from "./semantic-preselection.mjs";

function bootstrap() {
  return {
    tools: [
      { type: "function", name: "restaurant_conversation", description: "Ask a follow-up or continue ordinary conversation.", parameters: { type: "object", properties: {} } },
      { type: "function", name: "restaurant_business_info", description: "Read authoritative business information.", parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } },
      {
        type: "function",
        name: "restaurant_reservation_create",
        description: "Create or continue a reservation after the caller has chosen a concrete date and time; partial arguments are accepted so the backend can continue a multi-turn draft.",
        parameters: {
          type: "object",
          properties: {
            party_size: { type: "integer" },
            starts_at: { type: "string" },
            confirm: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    ],
  };
}

test("preselection request reflects production-like partial reservation schemas without treating empty required as readiness", () => {
  const request = buildSemanticPreselectionRequest(bootstrap(), "quiero hacer una reserva");
  assert.equal(request.inputText, "quiero hacer una reserva");
  assert.equal(request.instructions.includes("quiero hacer una reserva"), false);
  assert.equal(request.instructions.includes("Declared required inputs: topic."), true);
  assert.equal(request.instructions.includes("restaurant_reservation_create: Create or continue a reservation after the caller has chosen a concrete date and time"), true);
  assert.equal(request.instructions.includes("Declared required inputs: none."), true);
  assert.equal(request.instructions.includes("Available input fields: party_size, starts_at, confirm."), true);
  assert.equal(request.instructions.includes("Missing or empty required fields never mean that an intent-only turn is semantically ready"), true);
  assert.equal(request.instructions.includes("supports progressive or partial arguments must not be preselected"), true);
  assert.equal(request.responseMimeType, "application/json");
  assert.deepEqual(request.allowedToolNames, [
    "restaurant_conversation",
    "restaurant_business_info",
    "restaurant_reservation_create",
  ]);
  assert.deepEqual(request.responseJsonSchema.properties.selectedTool.enum, request.allowedToolNames);
});

test("structured parser authorizes direct model output only for restaurant_conversation", () => {
  assert.deepEqual(parseSemanticPreselection('{"selectedTool":"restaurant_conversation"}', ["restaurant_conversation"]), {
    selectedTool: "restaurant_conversation",
    directModelOutputAllowed: true,
  });
  assert.deepEqual(parseSemanticPreselection('{"selectedTool":"restaurant_business_info"}', ["restaurant_business_info"]), {
    selectedTool: "restaurant_business_info",
    directModelOutputAllowed: false,
  });
});

test("structured parser fails closed on prose, malformed, extra, empty and unsupported decisions", () => {
  const allowed = ["restaurant_conversation", "restaurant_business_info"];
  assert.throws(() => parseSemanticPreselection("Use restaurant_conversation", allowed), /invalid structured output/);
  assert.throws(() => parseSemanticPreselection('{"selectedTool":"restaurant_conversation"', allowed), /invalid structured output/);
  assert.throws(() => parseSemanticPreselection('{"selectedTool":"restaurant_conversation","extra":true}', allowed), /invalid structured output/);
  assert.throws(() => parseSemanticPreselection('{"selectedTool":"restaurant_reservation_create"}', allowed), /unsupported tool/);
  assert.throws(() => parseSemanticPreselection("   ", allowed), /result is required/);
});

test("isolated resolver preserves exact schema-constrained decision contract", async () => {
  const calls = [];
  const result = await resolveSemanticPreselection(async (request) => {
    calls.push(request);
    return '{"selectedTool":"restaurant_conversation"}';
  }, bootstrap(), "quiero hacer una reserva");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inputText, "quiero hacer una reserva");
  assert.equal(calls[0].maxOutputTokens, 64);
  assert.equal(calls[0].responseMimeType, "application/json");
  assert.equal(calls[0].instructions.includes("Declared required inputs: none."), true);
  assert.equal(calls[0].instructions.includes("Available input fields: party_size, starts_at, confirm."), true);
  assert.deepEqual(calls[0].responseJsonSchema.properties.selectedTool.enum, [
    "restaurant_conversation",
    "restaurant_business_info",
    "restaurant_reservation_create",
  ]);
  assert.deepEqual(result, {
    selectedTool: "restaurant_conversation",
    directModelOutputAllowed: true,
  });
});

test("conversation preselection permits direct model output only after control-plane confirmation", () => {
  const gate = new GeminiSemanticToolGate();
  gate.preArm("item-1");
  gate.preselect("item-1", { selectedTool: "restaurant_conversation", directModelOutputAllowed: true });
  assert.throws(
    () => gate.observeProviderMessage({ serverContent: { modelTurn: {} } }),
    /before control-plane gate confirmation/,
  );
  gate.confirmArm();
  assert.doesNotThrow(() => gate.observeProviderMessage({ serverContent: { modelTurn: {} } }));
  assert.equal(gate.snapshot().directModelOutputObserved, true);
  gate.observeProviderMessage({ serverContent: { turnComplete: true } });
  assert.equal(gate.snapshot().armed, false);
});

test("governed preselection still rejects direct model output without a live tool call", () => {
  const gate = new GeminiSemanticToolGate();
  gate.preArm("item-2");
  gate.preselect("item-2", { selectedTool: "restaurant_business_info", directModelOutputAllowed: false });
  gate.confirmArm();
  assert.throws(
    () => gate.observeProviderMessage({ serverContent: { modelTurn: {} } }),
    /bypassed a governed preselected tool/,
  );
});

test("matching live tool call is coherent and conflicting live tool call fails closed", () => {
  const matching = new GeminiSemanticToolGate();
  matching.preArm("item-3");
  matching.preselect("item-3", { selectedTool: "restaurant_business_info", directModelOutputAllowed: false });
  matching.confirmArm();
  assert.doesNotThrow(() => matching.observeProviderMessage({
    toolCall: { functionCalls: [{ id: "call-1", name: "restaurant_business_info" }] },
  }));
  assert.equal(matching.snapshot().selectedCallId, "call-1");

  const conflicting = new GeminiSemanticToolGate();
  conflicting.preArm("item-4");
  conflicting.preselect("item-4", { selectedTool: "restaurant_conversation", directModelOutputAllowed: true });
  conflicting.confirmArm();
  assert.throws(() => conflicting.observeProviderMessage({
    toolCall: { functionCalls: [{ id: "call-2", name: "restaurant_business_info" }] },
  }), /conflicts with isolated preselection/);
});

test("un-preselected gate preserves legacy fail-closed behavior", () => {
  const gate = new GeminiSemanticToolGate();
  gate.preArm("item-5");
  gate.confirmArm();
  assert.throws(
    () => gate.observeProviderMessage({ serverContent: { modelTurn: {} } }),
    /before semantic tool selection/,
  );
});
