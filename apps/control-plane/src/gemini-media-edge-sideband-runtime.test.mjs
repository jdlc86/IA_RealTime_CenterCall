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

test("sideband semantic tool gate emits only explicit ARM and RELEASE control commands", () => {
  const { runtime, sent } = runtimeHarness();
  runtime.semanticToolGatePort.arm();
  runtime.semanticToolGatePort.release();
  assert.deepEqual(sent, [
    { type: "SEMANTIC_GATE_ARM" },
    { type: "SEMANTIC_GATE_RELEASE" },
  ]);
});

test("sideband routes caller input controls to the product-owned media edge", () => {
  const { runtime, sent } = runtimeHarness();
  runtime.commandPort.suspendInputDetection();
  runtime.commandPort.clearInput();
  runtime.commandPort.beginNonInterruptingListening({ interruptResponse: false });
  runtime.commandPort.restoreInputDetection({ interruptResponse: true });
  assert.deepEqual(sent, [
    { type: "INPUT_DETECTION_SUSPEND" },
    { type: "CALLER_INPUT_CLEAR" },
    { type: "INPUT_DETECTION_RESTORE" },
    { type: "INPUT_DETECTION_RESTORE" },
  ]);
});

test("sideband normalizes product-owned input detection confirmations", () => {
  const { runtime } = runtimeHarness();
  assert.deepEqual(runtime.observe({
    type: "INPUT_DETECTION_EVENT",
    event: { type: "INPUT_DETECTION_UPDATED", present: true, settings: null },
  }).events, [{ type: "INPUT_DETECTION_UPDATED", present: true, settings: null }]);
  assert.deepEqual(runtime.observe({
    type: "INPUT_DETECTION_EVENT",
    event: {
      type: "INPUT_DETECTION_UPDATED",
      present: true,
      settings: { createResponse: false, interruptResponse: false },
    },
  }).events, [{
    type: "INPUT_DETECTION_UPDATED",
    present: true,
    settings: { createResponse: false, interruptResponse: false },
  }]);
});

test("sideband playback clear carries the exact active physical response identity", () => {
  const { runtime, sent } = runtimeHarness();
  assert.throws(() => runtime.commandPort.clearPlayback(), /requires active correlated playback/);
  runtime.observe({
    type: "PLAYBACK_EVENT",
    event: { type: "ASSISTANT_AUDIO_STARTED", responseId: "governed-1", kind: "GREETING" },
  });
  runtime.commandPort.clearPlayback();
  assert.deepEqual(sent, [{ type: "PLAYBACK_CLEAR", responseId: "governed-1" }]);
});

test("sideband governed speech requires exact text and preserves or mints response identity", () => {
  const { runtime, sent } = runtimeHarness();
  assert.throws(() => runtime.governedSpeechPort.speak({ instructions: "say something" }), /exact text is required/);

  runtime.governedSpeechPort.speak({
    requestId: "protected-response-1",
    instructions: "Pronuncia exactamente el texto.",
    exactText: "Hola.",
    purpose: "initial_greeting",
  });
  assert.deepEqual(sent.at(-1), {
    type: "GOVERNED_SPEECH",
    responseId: "protected-response-1",
    text: "Hola.",
    purpose: "initial_greeting",
  });

  runtime.governedSpeechPort.speak({
    instructions: "Pronuncia exactamente el texto.",
    exactText: "¿Deseas que te transfiera?",
  });
  assert.equal(sent.at(-1).type, "GOVERNED_SPEECH");
  assert.match(sent.at(-1).responseId, /^gemini_governed_speech_[0-9a-f-]{36}$/);
  assert.equal(sent.at(-1).text, "¿Deseas que te transfiera?");

  runtime.governedSpeechPort.speak({
    requestId: "handoff-response-1",
    instructions: "Anuncia la transferencia.",
    exactText: "Te transfiero ahora.",
    purpose: "human_handoff_announcement_v37",
    metadata: { human_handoff_v37: "ANNOUNCEMENT" },
  });
  assert.deepEqual(sent.at(-1), {
    type: "GOVERNED_SPEECH",
    responseId: "handoff-response-1",
    text: "Te transfiero ahora.",
    kind: "HANDOFF",
    purpose: "human_handoff_announcement_v37",
  });
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
  runtime.commandPort.createDefaultResponse();
  assert.deepEqual(sent, [{ type: "CALLER_TURN_DECISION", itemId: "gemini-candidate-1", decision: "NORMAL", responseId: null }]);
  assert.throws(() => runtime.commandPort.createDefaultResponse(), /default response creation/);
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
  assert.throws(() => runtime.commandPort.createDefaultResponse(), /default response creation/);
});

test("sideband tool call preserves provider identity through owner and FunctionResponse", () => {
  const { runtime, sent } = runtimeHarness(); ready(runtime);
  const observation = runtime.observe({ type: "GEMINI_EVENT", message: { toolCall: { functionCalls: [{ id: "fc-edge-1", name: "restaurant_business_info", args: { topics: ["HOURS"] } }] } } });
  assert.equal(observation.snapshot.state, "TOOL_WAIT");
  runtime.commandPort.submitToolResult({ callId: "fc-edge-1", toolName: "restaurant_business_info", output: { ok: true } });
  assert.deepEqual(sent.at(-1), { type: "TOOL_RESULT", callId: "fc-edge-1", toolName: "restaurant_business_info", output: { ok: true } });
});

test("deterministic tool result resets the provider without emitting a FunctionResponse and preserves continuity", () => {
  const { runtime, sent } = runtimeHarness(); ready(runtime);
  runtime.observe({
    type: "GEMINI_EVENT",
    message: { toolCall: { functionCalls: [{ id: "fc-edge-deterministic-1", name: "restaurant_reservation_create", args: {} }] } },
  });
  runtime.commandPort.bypassDeterministicToolContinuation(
    {
      callId: "fc-edge-deterministic-1",
      toolName: "restaurant_reservation_create",
      output: { ok: true, status: "AVAILABLE_NEEDS_CONTACT", missing: ["customer_name"] },
    },
    "RESERVATION_CUSTOMER_NAME",
  );
  assert.deepEqual(sent, [
    { type: "PLAYBACK_BINDING", responseId: "gemini-response-1", kind: "NORMAL" },
    {
      type: "DETERMINISTIC_TOOL_BYPASS",
      callId: "fc-edge-deterministic-1",
      toolName: "restaurant_reservation_create",
      responseId: "gemini-response-1",
      continuationContext: "RESERVATION_CUSTOMER_NAME",
    },
  ]);
  assert.equal(sent.some((message) => message.type === "TOOL_RESULT"), false);

  const reset = runtime.observe({
    type: "PROVIDER_SESSION_RESET",
    event: { callId: "fc-edge-deterministic-1", responseId: "gemini-response-1" },
  });
  assert.deepEqual(reset.events, [{
    type: "ASSISTANT_RESPONSE_COMPLETED",
    kind: "NORMAL",
    responseId: "gemini-response-1",
    status: "interrupted",
  }]);
  assert.equal(reset.snapshot.state, "SETUP_SENT");

  ready(runtime);
  runtime.observe({
    type: "GEMINI_EVENT",
    message: { toolCall: { functionCalls: [{ id: "fc-edge-deterministic-2", name: "restaurant_reservation_create", args: { customer_name: "Juan" } }] } },
  });
  runtime.commandPort.submitToolResult({
    callId: "fc-edge-deterministic-2",
    toolName: "restaurant_reservation_create",
    output: { ok: true, status: "READY_TO_CONFIRM" },
  });
  assert.deepEqual(sent.at(-1), {
    type: "TOOL_RESULT",
    callId: "fc-edge-deterministic-2",
    toolName: "restaurant_reservation_create",
    output: { ok: true, status: "READY_TO_CONFIRM" },
  });
});

test("sideband rejects unsupported envelopes and stale tools", () => {
  const { runtime } = runtimeHarness(); ready(runtime);
  assert.throws(() => runtime.observe({ type: "OPENAI_EVENT", message: {} }), /frame type is unsupported/);
  assert.throws(() => runtime.commandPort.submitToolResult({ callId: "unknown", toolName: "x", output: {} }), /does not match a pending call/);
});
