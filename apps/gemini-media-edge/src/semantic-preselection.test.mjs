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
      { type: "function", name: "restaurant_conversation", description: "Ask a follow-up or continue ordinary conversation.", parameters: {} },
      { type: "function", name: "restaurant_business_info", description: "Read authoritative business information.", parameters: {} },
      { type: "function", name: "restaurant_reservation_create", description: "Create an authoritative reservation.", parameters: {} },
    ],
  };
}

test("preselection request exposes only bootstrap tool identities and no transcript in instructions", () => {
  const request = buildSemanticPreselectionRequest(bootstrap(), "quiero hacer una reserva");
  assert.equal(request.inputText, "quiero hacer una reserva");
  assert.equal(request.instructions.includes("quiero hacer una reserva"), false);
  assert.deepEqual(request.allowedToolNames, [
    "restaurant_conversation",
    "restaurant_business_info",
    "restaurant_reservation_create",
  ]);
});

test("parser authorizes direct model output only for restaurant_conversation", () => {
  assert.deepEqual(parseSemanticPreselection("restaurant_conversation", ["restaurant_conversation"]), {
    selectedTool: "restaurant_conversation",
    directModelOutputAllowed: true,
  });
  assert.deepEqual(parseSemanticPreselection("restaurant_business_info", ["restaurant_business_info"]), {
    selectedTool: "restaurant_business_info",
    directModelOutputAllowed: false,
  });
});

test("parser fails closed on prose, malformed, empty and unsupported decisions", () => {
  const allowed = ["restaurant_conversation", "restaurant_business_info"];
  assert.throws(() => parseSemanticPreselection("Use restaurant_conversation", allowed), /unsupported tool/);
  assert.throws(() => parseSemanticPreselection("restaurant_reservation_create", allowed), /unsupported tool/);
  assert.throws(() => parseSemanticPreselection("   ", allowed), /result is required/);
});

test("isolated resolver preserves exact closed decision contract", async () => {
  const calls = [];
  const result = await resolveSemanticPreselection(async (request) => {
    calls.push(request);
    return "restaurant_conversation";
  }, bootstrap(), "quiero reservar");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inputText, "quiero reservar");
  assert.equal(calls[0].maxOutputTokens, 32);
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
