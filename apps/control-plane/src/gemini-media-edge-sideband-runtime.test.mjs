import assert from "node:assert/strict";
import test from "node:test";
import { GeminiMediaEdgeSidebandRuntime } from "../.test-dist/gemini-media-edge-sideband-runtime.js";

function runtimeHarness() {
  const sent = [];
  const runtime = new GeminiMediaEdgeSidebandRuntime((message) => sent.push(message));
  return { runtime, sent };
}
function ready(runtime) { runtime.observe({ type: "GEMINI_EVENT", message: { setupComplete: {} } }); }

test("sideband setupComplete advances the existing Gemini session owner", () => {
  const { runtime, sent } = runtimeHarness();
  assert.equal(runtime.snapshot().state, "SETUP_SENT");
  ready(runtime);
  assert.equal(runtime.snapshot().state, "READY");
  assert.deepEqual(sent, []);
});

test("sideband returns owner response binding and completion drain", () => {
  const { runtime, sent } = runtimeHarness(); ready(runtime);
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } });
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { turnComplete: true } } });
  assert.deepEqual(sent, [
    { type: "PLAYBACK_BINDING", responseId: "gemini-response-1", kind: "NORMAL" },
    { type: "PLAYBACK_DRAIN", responseId: "gemini-response-1" },
  ]);
});

test("normal caller decision requires current response and playback to be idle", () => {
  const { runtime, sent } = runtimeHarness(); ready(runtime);
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: null } });
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STOPPED", itemId: "gemini-candidate-1" } });
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "Quiero reservar" } });
  assert.deepEqual(runtime.resolveCallerTurn("gemini-candidate-1", "NORMAL"), { itemId: "gemini-candidate-1", playbackResponseIdAtStart: null });
  assert.deepEqual(sent, [{ type: "CALLER_TURN_DECISION", itemId: "gemini-candidate-1", decision: "NORMAL", responseId: null }]);
  assert.equal(runtime.callerContext("gemini-candidate-1"), null);
});

test("interrupt decision requires the exact playback identity captured at speech start", () => {
  const { runtime, sent } = runtimeHarness(); ready(runtime);
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } });
  runtime.observe({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-1" } });
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: "gemini-response-1" } });
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "Espera" } });
  assert.throws(() => runtime.resolveCallerTurn("gemini-candidate-1", "NORMAL"), /requires idle response and playback/);
  assert.deepEqual(runtime.resolveCallerTurn("gemini-candidate-1", "INTERRUPT"), { itemId: "gemini-candidate-1", playbackResponseIdAtStart: "gemini-response-1" });
  assert.deepEqual(sent.at(-1), { type: "CALLER_TURN_DECISION", itemId: "gemini-candidate-1", decision: "INTERRUPT", responseId: "gemini-response-1" });
});

test("interrupt becomes a normal turn when the captured response and playback fully drained before decision", () => {
  const { runtime, sent } = runtimeHarness(); ready(runtime);
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } });
  runtime.observe({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-1" } });
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: "gemini-response-1" } });
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "Espera" } });
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { turnComplete: true } } });
  runtime.observe({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STOPPED", kind: "NORMAL", responseId: "gemini-response-1" } });
  assert.deepEqual(runtime.resolveCallerTurn("gemini-candidate-1", "INTERRUPT"), { itemId: "gemini-candidate-1", playbackResponseIdAtStart: "gemini-response-1" });
  assert.deepEqual(sent.at(-1), { type: "CALLER_TURN_DECISION", itemId: "gemini-candidate-1", decision: "NORMAL", responseId: null });
});

test("interrupt fails closed if a newer response supersedes the captured playback target", () => {
  const { runtime } = runtimeHarness(); ready(runtime);
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } });
  runtime.observe({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-1" } });
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: "gemini-response-1" } });
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "Espera" } });
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { turnComplete: true } } });
  runtime.observe({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STOPPED", kind: "NORMAL", responseId: "gemini-response-1" } });
  runtime.observe({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } });
  assert.throws(() => runtime.resolveCallerTurn("gemini-candidate-1", "INTERRUPT"), /superseded by active response gemini-response-2/);
});

test("ignore discards either normal or overlapping caller candidates without provider effects", () => {
  const { runtime, sent } = runtimeHarness(); ready(runtime);
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: null } });
  runtime.observe({ type: "CALLER_EVENT", event: { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "ruido" } });
  runtime.resolveCallerTurn("gemini-candidate-1", "IGNORE");
  assert.deepEqual(sent, [{ type: "CALLER_TURN_DECISION", itemId: "gemini-candidate-1", decision: "IGNORE", responseId: null }]);
});

test("sideband tool call preserves provider identity through owner and FunctionResponse", () => {
  const { runtime, sent } = runtimeHarness(); ready(runtime);
  const observation = runtime.observe({ type: "GEMINI_EVENT", message: { toolCall: { functionCalls: [{ id: "fc-edge-1", name: "restaurant_business_info", args: { topics: ["HOURS"] } }] } } });
  assert.equal(observation.snapshot.state, "TOOL_WAIT");
  runtime.commandPort.submitToolResult({ callId: "fc-edge-1", toolName: "restaurant_business_info", output: { ok: true } });
  assert.deepEqual(sent.at(-1), { type: "TOOL_RESULT", callId: "fc-edge-1", toolName: "restaurant_business_info", output: { ok: true } });
});

test("sideband rejects unsupported envelopes and stale tools", () => {
  const { runtime } = runtimeHarness(); ready(runtime);
  assert.throws(() => runtime.observe({ type: "OPENAI_EVENT", message: {} }), /frame type is unsupported/);
  assert.throws(() => runtime.commandPort.submitToolResult({ callId: "unknown", toolName: "x", output: {} }), /does not match a pending call/);
});
