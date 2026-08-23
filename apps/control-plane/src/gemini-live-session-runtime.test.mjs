import assert from "node:assert/strict";
import test from "node:test";
import { GeminiLiveSessionRuntime } from "../.test-dist/gemini-live-session-runtime.js";

function host({ failOnSend = null } = {}) {
  const sent = [];
  return {
    sent,
    send(message) {
      if (failOnSend && failOnSend(message)) throw new Error("wire send failed");
      sent.push(message);
    },
  };
}

function wire(message) {
  return JSON.stringify(message);
}

function startedRuntime(h = host()) {
  const runtime = new GeminiLiveSessionRuntime(h, {
    model: "models/gemini-live-test",
    instructions: "Lucia test",
    responseModalities: ["AUDIO"],
  });
  assert.equal(runtime.start().state, "SETUP_SENT");
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], {
    setup: {
      model: "models/gemini-live-test",
      systemInstruction: { parts: [{ text: "Lucia test" }] },
      generationConfig: { responseModalities: ["AUDIO"] },
    },
  });
  runtime.observe(wire({ setupComplete: {} }));
  assert.equal(runtime.snapshot().state, "READY");
  return { runtime, h };
}

test("runtime owns the immutable initial setup and rejects a second start", () => {
  const h = host();
  const runtime = new GeminiLiveSessionRuntime(h, { model: "models/gemini-live-test" });
  runtime.start();
  assert.equal(h.sent.length, 1);
  assert.throws(() => runtime.start(), /setup can only be sent once/);
  assert.equal(h.sent.length, 1);
});

test("setup send failure closes the owner instead of leaving a phantom session", () => {
  const h = host({ failOnSend: (message) => Boolean(message.setup) });
  const runtime = new GeminiLiveSessionRuntime(h, { model: "models/gemini-live-test" });
  assert.throws(() => runtime.start(), /wire send failed/);
  assert.equal(runtime.snapshot().state, "CLOSED");
});

test("runtime merges owner lifecycle with stateless semantic tool translation", () => {
  const { runtime } = startedRuntime();
  const observation = runtime.observe(wire({
    toolCall: {
      functionCalls: [{ id: "fc-1", name: "reservation_search", args: { party_size: 2 } }],
    },
  }));

  assert.deepEqual(observation.events, [
    {
      type: "ASSISTANT_RESPONSE_STARTED",
      kind: "NORMAL",
      responseId: "gemini-response-1",
      purpose: "tool_call",
    },
    {
      type: "SEMANTIC_TOOL_SELECTED",
      name: "reservation_search",
      arguments: JSON.stringify({ party_size: 2 }),
      callId: "fc-1",
    },
  ]);
  assert.equal(observation.snapshot.state, "TOOL_WAIT");
});

test("owned command port writes a correlated FunctionResponse then advances tool ownership", () => {
  const { runtime, h } = startedRuntime();
  runtime.observe(wire({ toolCall: { functionCalls: [{ id: "fc-2", name: "reservation_search" }] } }));
  const before = h.sent.length;

  runtime.commandPort.submitToolResult({
    callId: "fc-2",
    toolName: "reservation_search",
    output: { ok: true, slots: [] },
  });

  assert.equal(h.sent.length, before + 1);
  assert.deepEqual(h.sent.at(-1), {
    toolResponse: {
      functionResponses: [{
        id: "fc-2",
        name: "reservation_search",
        response: { result: { ok: true, slots: [] } },
      }],
    },
  });
  assert.equal(runtime.snapshot().state, "GENERATING");
  assert.deepEqual(runtime.snapshot().pendingToolCallIds, []);
});

test("stale or cancelled tool results fail before any FunctionResponse is emitted", () => {
  const { runtime, h } = startedRuntime();
  runtime.observe(wire({ toolCall: { functionCalls: [{ id: "fc-cancel", name: "reservation_create" }] } }));
  runtime.observe(wire({ serverContent: { interrupted: true } }));
  runtime.observe(wire({ toolCallCancellation: { ids: ["fc-cancel"] } }));
  const before = h.sent.length;

  assert.throws(
    () => runtime.commandPort.submitToolResult({
      callId: "fc-cancel",
      toolName: "reservation_create",
      output: { ok: true },
    }),
    /does not match a pending call/,
  );
  assert.equal(h.sent.length, before);
});

test("wire failure while sending FunctionResponse preserves pending ownership", () => {
  const h = host({ failOnSend: (message) => Boolean(message.toolResponse) });
  const { runtime } = startedRuntime(h);
  runtime.observe(wire({ toolCall: { functionCalls: [{ id: "fc-retry", name: "reservation_search" }] } }));

  assert.throws(
    () => runtime.commandPort.submitToolResult({
      callId: "fc-retry",
      toolName: "reservation_search",
      output: { ok: true },
    }),
    /wire send failed/,
  );
  assert.equal(runtime.snapshot().state, "TOOL_WAIT");
  assert.deepEqual(runtime.snapshot().pendingToolCallIds, ["fc-retry"]);
});

test("transcription chunks remain out-of-band evidence at the composed edge", () => {
  const { runtime } = startedRuntime();
  const observation = runtime.observe(wire({
    serverContent: { inputTranscription: { text: "mañana a las nueve" } },
  }));
  assert.deepEqual(observation.events, []);
  assert.deepEqual(observation.transcriptionChunks, [{ direction: "INPUT", text: "mañana a las nueve" }]);
});
