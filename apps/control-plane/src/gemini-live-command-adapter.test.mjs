import assert from "node:assert/strict";
import test from "node:test";
import { GeminiLiveCommandAdapter } from "./gemini-live-command-adapter.ts";

function harness() {
  const sent = [];
  return { sent, adapter: new GeminiLiveCommandAdapter({ send(message) { sent.push(message); } }) };
}

test("Gemini Live semantic response sends provider text input without OpenAI wire", () => {
  const { sent, adapter } = harness();
  adapter.createSemanticResponse({ callerTurnText: "Quiero reservar para cuatro" });
  assert.deepEqual(sent, [{ realtimeInput: { text: "Quiero reservar para cuatro" } }]);
});

test("Gemini Live maps neutral function catalog into session setup", () => {
  const { sent, adapter } = harness();
  adapter.updateSessionPolicy({
    instructions: "Eres Lucía.",
    toolChoice: "AUTO",
    tools: [{ type: "function", name: "restaurant_search", description: "Busca disponibilidad", parameters: { type: "object" } }],
  });
  assert.deepEqual(sent, [{ setup: {
    systemInstruction: { parts: [{ text: "Eres Lucía." }] },
    tools: [{ functionDeclarations: [{ name: "restaurant_search", description: "Busca disponibilidad", parameters: { type: "object" } }] }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
  } }]);
});

test("Gemini Live tool response preserves provider call identity", () => {
  const { sent, adapter } = harness();
  adapter.submitToolResult({ callId: "fc_9", toolName: "restaurant_search", output: { status: "AVAILABLE" } });
  assert.deepEqual(sent, [{ toolResponse: { functionResponses: [{
    id: "fc_9",
    name: "restaurant_search",
    response: { result: { status: "AVAILABLE" } },
  }] } }]);
});

test("Gemini Live fails closed when a tool result lacks correlation identity", () => {
  const { adapter } = harness();
  assert.throws(() => adapter.submitToolResult({ output: { ok: true } }), /require callId and toolName/);
});

test("G2 refuses to fake audio controls before media conformance", () => {
  const { adapter } = harness();
  assert.throws(() => adapter.clearPlayback(), /G3 media integration/);
  assert.throws(() => adapter.restoreInputDetection(), /G4 conformance/);
});
