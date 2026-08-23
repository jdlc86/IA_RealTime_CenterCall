import assert from "node:assert/strict";
import test from "node:test";
import { GeminiMediaEdgeSidebandRuntime } from "../.test-dist/gemini-media-edge-sideband-runtime.js";

function runtimeHarness() {
  const sent = [];
  const runtime = new GeminiMediaEdgeSidebandRuntime((message) => sent.push(message));
  return { runtime, sent };
}

test("sideband setupComplete advances the existing Gemini session owner", () => {
  const { runtime, sent } = runtimeHarness();
  assert.equal(runtime.snapshot().state, "SETUP_SENT");
  const observation = runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } });
  assert.equal(observation.snapshot.state, "READY");
  assert.deepEqual(sent, []);
});

test("sideband tool call preserves provider identity through owner and FunctionResponse", () => {
  const { runtime, sent } = runtimeHarness();
  runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } });
  const observation = runtime.observe({
    type: "GEMINI_EVENT",
    message: { toolCall: { functionCalls: [{ id: "fc-edge-1", name: "restaurant_business_info", args: { topics: ["HOURS"] } }] } },
  });
  assert.deepEqual(observation.events, [
    { type: "ASSISTANT_RESPONSE_STARTED", kind: "NORMAL", responseId: "gemini-response-1", purpose: "tool_call" },
    { type: "SEMANTIC_TOOL_SELECTED", name: "restaurant_business_info", arguments: JSON.stringify({ topics: ["HOURS"] }), callId: "fc-edge-1" },
  ]);
  assert.equal(runtime.snapshot().state, "TOOL_WAIT");

  runtime.commandPort.submitToolResult({
    callId: "fc-edge-1",
    toolName: "restaurant_business_info",
    output: { ok: true, hours: "09:00-22:00" },
  });
  assert.deepEqual(sent, [{
    type: "TOOL_RESULT",
    callId: "fc-edge-1",
    toolName: "restaurant_business_info",
    output: { ok: true, hours: "09:00-22:00" },
  }]);
  assert.deepEqual(runtime.snapshot().pendingToolCallIds, []);
});

test("sideband cannot submit stale tool results or arbitrary provider commands", () => {
  const { runtime, sent } = runtimeHarness();
  runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } });
  assert.throws(() => runtime.commandPort.submitToolResult({ callId: "unknown", toolName: "x", output: {} }), /does not match a pending call/);
  assert.throws(() => runtime.commandPort.createDefaultResponse(), /default response creation/);
  assert.deepEqual(sent, []);
});

test("sideband rejects non-Gemini envelopes", () => {
  const { runtime } = runtimeHarness();
  assert.throws(() => runtime.observe({ type: "OPENAI_EVENT", message: {} }), /frame type is unsupported/);
});
