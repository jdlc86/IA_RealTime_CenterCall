import assert from "node:assert/strict";
import test from "node:test";
import {
  GeminiLiveCommandAdapter,
  buildGeminiLiveInitialSetup,
} from "./gemini-live-command-adapter.ts";

function harness() {
  const sent = [];
  return { sent, adapter: new GeminiLiveCommandAdapter({ send(message) { sent.push(message); } }) };
}

test("Gemini Live initial setup is built once outside the runtime session-policy port", () => {
  assert.deepEqual(buildGeminiLiveInitialSetup({
    model: "models/gemini-live",
    instructions: "Eres Lucía.",
    responseModalities: ["AUDIO"],
    enableInputTranscription: true,
    enableOutputTranscription: true,
    tools: [{ type: "function", name: "restaurant_search", description: "Busca disponibilidad", parameters: { type: "object" } }],
  }), {
    setup: {
      model: "models/gemini-live",
      systemInstruction: { parts: [{ text: "Eres Lucía." }] },
      tools: [{ functionDeclarations: [{ name: "restaurant_search", description: "Busca disponibilidad", parameters: { type: "object" } }] }],
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });
});

test("Gemini Live does not fake dynamic session updates with a second setup message", () => {
  const { sent, adapter } = harness();
  assert.throws(
    () => adapter.updateSessionPolicy({ instructions: "changed", toolChoice: "REQUIRED" }),
    /no proven neutral mapping before immutable setup composition/,
  );
  assert.deepEqual(sent, []);
});

test("Gemini Live never disguises governed assistant commands as realtime caller text", () => {
  const { sent, adapter } = harness();
  assert.throws(() => adapter.speak({ instructions: "Di hola" }), /governed speech/);
  assert.throws(() => adapter.requestTextDecision({ instructions: "clasifica", inputText: "hola" }), /isolated text decision/);
  assert.throws(() => adapter.createSemanticResponse({ callerTurnText: "Quiero reservar" }), /synthetic semantic response/);
  assert.throws(() => adapter.createDefaultResponse(), /default response creation/);
  assert.deepEqual(sent, []);
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

test("Gemini Live tool response fails closed without correlation identity", () => {
  const { adapter } = harness();
  assert.throws(() => adapter.submitToolResult({ output: { ok: true } }), /require callId and toolName/);
});

test("G2 refuses to fake audio controls before media conformance", () => {
  const { adapter } = harness();
  assert.throws(() => adapter.clearPlayback(), /G3 media integration/);
  assert.throws(() => adapter.restoreInputDetection(), /G4 conformance/);
});
