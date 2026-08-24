import test from "node:test";
import assert from "node:assert/strict";
import { GeminiSemanticToolGate } from "./semantic-tool-gate.mjs";

function toolCall(id = "fc-1", name = "restaurant_business_info") {
  return { toolCall: { functionCalls: [{ id, name, args: {} }] } };
}

test("Gemini semantic gate requires pre-authorized caller ownership before control-plane arm", () => {
  const gate = new GeminiSemanticToolGate();
  assert.throws(() => gate.confirmArm(), /pre-authorized caller turn/);
  gate.preArm("item-1");
  assert.deepEqual(gate.snapshot(), {
    armed: true,
    activeItemId: "item-1",
    confirmed: false,
    selectedTool: null,
    selectedCallId: null,
  });
  gate.confirmArm();
  assert.equal(gate.snapshot().confirmed, true);
});

test("Gemini semantic gate forbids assistant semantic output before tool selection and before release", () => {
  const gate = new GeminiSemanticToolGate();
  gate.preArm("item-1");
  gate.confirmArm();

  assert.throws(
    () => gate.observeProviderMessage({ serverContent: { modelTurn: { parts: [{ text: "hola" }] } } }),
    /before semantic tool selection/,
  );

  gate.observeProviderMessage(toolCall());
  assert.equal(gate.snapshot().selectedTool, "restaurant_business_info");
  assert.throws(
    () => gate.observeProviderMessage({ serverContent: { outputTranscription: { text: "Abrimos a las nueve" } } }),
    /before semantic gate release/,
  );
});

test("Gemini semantic gate admits exactly one tool decision for the caller turn", () => {
  const gate = new GeminiSemanticToolGate();
  gate.preArm("item-1");
  gate.confirmArm();
  gate.observeProviderMessage(toolCall("fc-1", "restaurant_business_info"));

  gate.observeProviderMessage(toolCall("fc-1", "restaurant_business_info"));
  assert.throws(
    () => gate.observeProviderMessage(toolCall("fc-2", "restaurant_conversation")),
    /second tool decision/,
  );
  assert.throws(
    () => gate.observeProviderMessage({ toolCall: { functionCalls: [
      { id: "fc-2", name: "restaurant_conversation" },
      { id: "fc-3", name: "restaurant_end_call" },
    ] } }),
    /multiple tool decisions/,
  );
});

test("Gemini semantic gate releases only after control-plane confirmation and provider tool selection", () => {
  const gate = new GeminiSemanticToolGate();
  gate.preArm("item-1");
  assert.throws(() => gate.release(), /not confirmed/);
  gate.confirmArm();
  assert.throws(() => gate.release(), /before tool selection/);
  gate.observeProviderMessage(toolCall());
  gate.release();
  assert.deepEqual(gate.snapshot(), {
    armed: false,
    activeItemId: null,
    confirmed: false,
    selectedTool: null,
    selectedCallId: null,
  });
});

test("Gemini semantic gate cannot leak ownership across caller items", () => {
  const gate = new GeminiSemanticToolGate();
  gate.preArm("item-1");
  assert.throws(() => gate.preArm("item-2"), /already owns caller item item-1/);
  gate.confirmArm();
  gate.observeProviderMessage(toolCall());
  gate.release();
  gate.preArm("item-2");
  assert.equal(gate.snapshot().activeItemId, "item-2");
});

test("Gemini semantic gate allows non-semantic provider evidence while armed", () => {
  const gate = new GeminiSemanticToolGate();
  gate.preArm("item-1");
  gate.confirmArm();
  assert.doesNotThrow(() => gate.observeProviderMessage({ serverContent: { inputTranscription: { text: "hola" } } }));
  assert.equal(gate.snapshot().selectedTool, null);
});
