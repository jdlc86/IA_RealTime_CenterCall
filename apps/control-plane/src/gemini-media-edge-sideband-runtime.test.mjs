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

test("sideband returns the owner-minted response id as playback binding", () => {
  const { runtime, sent } = runtimeHarness();
  runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } });
  const observation = runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } });
  assert.deepEqual(observation.events, [{ type: "ASSISTANT_RESPONSE_STARTED", kind: "NORMAL", responseId: "gemini-response-1", purpose: "model_turn" }]);
  assert.deepEqual(sent, [{ type: "PLAYBACK_BINDING", responseId: "gemini-response-1", kind: "NORMAL" }]);
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } });
  assert.equal(sent.length, 1);
});

test("normal Gemini response completion requests Telnyx drain but does not fabricate playback stop", () => {
  const { runtime, sent } = runtimeHarness();
  runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } });
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } });
  const completion = runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { turnComplete: true } } });
  assert.deepEqual(completion.events, [{ type: "ASSISTANT_RESPONSE_COMPLETED", kind: "NORMAL", responseId: "gemini-response-1", status: "completed" }]);
  assert.deepEqual(sent, [
    { type: "PLAYBACK_BINDING", responseId: "gemini-response-1", kind: "NORMAL" },
    { type: "PLAYBACK_DRAIN", responseId: "gemini-response-1" },
  ]);
});

test("edge playback evidence owns and releases exactly one response identity", () => {
  const { runtime } = runtimeHarness();
  runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } });
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } });
  assert.deepEqual(runtime.observe({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-1" } }).events,
    [{ type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-1" }]);
  assert.throws(() => runtime.observe({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-2" } }), /already owned/);
  assert.deepEqual(runtime.observe({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STOPPED", kind: "NORMAL", responseId: "gemini-response-1" } }).events,
    [{ type: "ASSISTANT_AUDIO_STOPPED", kind: "NORMAL", responseId: "gemini-response-1" }]);
});

test("caller edge evidence preserves playback identity separately from neutral events", () => {
  const { runtime } = runtimeHarness();
  runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } });
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } });
  runtime.observe({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-1" } });
  assert.deepEqual(runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: "gemini-response-1" } }).events,
    [{ type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1" }]);
  assert.deepEqual(runtime.callerContext("gemini-candidate-1"), { itemId: "gemini-candidate-1", playbackResponseIdAtStart: "gemini-response-1" });
  assert.deepEqual(runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STOPPED", itemId: "gemini-candidate-1" } }).events,
    [{ type: "CALLER_SPEECH_STOPPED" }]);
  assert.deepEqual(runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "Necesito otra cosa" } }).events,
    [{ type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "Necesito otra cosa" }]);
  assert.deepEqual(runtime.consumeCallerContext("gemini-candidate-1"), { itemId: "gemini-candidate-1", playbackResponseIdAtStart: "gemini-response-1" });
  assert.equal(runtime.callerContext("gemini-candidate-1"), null);
});

test("caller playback context fails closed when edge identity disagrees with observed playback", () => {
  const { runtime } = runtimeHarness();
  runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } });
  assert.throws(() => runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: "gemini-response-9" } }), /playback identity mismatch/);
});

test("sideband tool call preserves provider identity through owner and FunctionResponse", () => {
  const { runtime, sent } = runtimeHarness();
  runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } });
  const observation = runtime.observe({ type: "GEMINI_EVENT", message: { toolCall: { functionCalls: [{ id: "fc-edge-1", name: "restaurant_business_info", args: { topics: ["HOURS"] } }] } } });
  assert.deepEqual(observation.events, [
    { type: "ASSISTANT_RESPONSE_STARTED", kind: "NORMAL", responseId: "gemini-response-1", purpose: "tool_call" },
    { type: "SEMANTIC_TOOL_SELECTED", name: "restaurant_business_info", arguments: JSON.stringify({ topics: ["HOURS"] }), callId: "fc-edge-1" },
  ]);
  runtime.commandPort.submitToolResult({ callId: "fc-edge-1", toolName: "restaurant_business_info", output: { ok: true } });
  assert.deepEqual(sent.at(-1), { type: "TOOL_RESULT", callId: "fc-edge-1", toolName: "restaurant_business_info", output: { ok: true } });
});

test("sideband rejects unsupported envelopes and stale tools", () => {
  const { runtime } = runtimeHarness();
  runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } });
  assert.throws(() => runtime.observe({ type: "OPENAI_EVENT", message: {} }), /frame type is unsupported/);
  assert.throws(() => runtime.commandPort.submitToolResult({ callId: "unknown", toolName: "x", output: {} }), /does not match a pending call/);
});
