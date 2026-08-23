import assert from "node:assert/strict";
import test from "node:test";
import { GeminiLiveSessionOwner } from "../.test-dist/gemini-live-session-owner.js";

function wire(message) {
  return JSON.stringify(message);
}

function readyOwner() {
  const owner = new GeminiLiveSessionOwner();
  assert.equal(owner.markSetupSent().state, "SETUP_SENT");
  const observation = owner.observe(wire({ setupComplete: {} }));
  assert.equal(observation.snapshot.state, "READY");
  return owner;
}

test("Gemini Live setup is one-shot and setupComplete is required before server turns", () => {
  const owner = new GeminiLiveSessionOwner();
  assert.equal(owner.snapshot().state, "NEW");
  owner.markSetupSent();
  assert.throws(() => owner.markSetupSent(), /setup can only be sent once/);
  assert.throws(
    () => owner.observe(wire({ serverContent: { modelTurn: { parts: [{ text: "hola" }] } } })),
    /before setupComplete/,
  );
  assert.equal(owner.observe(wire({ setupComplete: {} })).snapshot.state, "READY");
});

test("model turn receives a stable neutral response id until turnComplete", () => {
  const owner = readyOwner();
  const first = owner.observe(wire({ serverContent: { modelTurn: { parts: [{ text: "uno" }] } } }));
  assert.deepEqual(first.events, [{
    type: "ASSISTANT_RESPONSE_STARTED",
    kind: "NORMAL",
    responseId: "gemini-response-1",
    purpose: "model_turn",
  }]);
  assert.equal(first.snapshot.state, "GENERATING");
  assert.equal(first.snapshot.activeResponseId, "gemini-response-1");

  const second = owner.observe(wire({ serverContent: { generationComplete: true } }));
  assert.deepEqual(second.events, []);
  assert.equal(second.snapshot.activeResponseId, "gemini-response-1");

  const done = owner.observe(wire({ serverContent: { turnComplete: true } }));
  assert.deepEqual(done.events, [{
    type: "ASSISTANT_RESPONSE_COMPLETED",
    kind: "NORMAL",
    responseId: "gemini-response-1",
    status: "completed",
  }]);
  assert.equal(done.snapshot.state, "READY");
  assert.equal(done.snapshot.activeResponseId, null);
});

test("input transcription remains evidence only and never fabricates caller completion", () => {
  const owner = readyOwner();
  const input = owner.observe(wire({ serverContent: { inputTranscription: { text: "quiero mesa" } } }));
  assert.deepEqual(input.events, []);
  assert.deepEqual(input.transcriptionChunks, [{ direction: "INPUT", text: "quiero mesa" }]);
  assert.equal(input.snapshot.state, "READY");
});

test("output transcription chunks finalize once under the owned response on turnComplete", () => {
  const owner = readyOwner();
  const first = owner.observe(wire({ serverContent: { outputTranscription: { text: " claro " } } }));
  assert.deepEqual(first.events, [{
    type: "ASSISTANT_RESPONSE_STARTED",
    kind: "NORMAL",
    responseId: "gemini-response-1",
    purpose: "output_transcription",
  }]);
  assert.deepEqual(first.transcriptionChunks, [{ direction: "OUTPUT", text: " claro " }]);
  assert.equal(first.snapshot.activeResponseId, "gemini-response-1");

  const second = owner.observe(wire({ serverContent: { outputTranscription: { text: "que sí" } } }));
  assert.deepEqual(second.events, []);
  assert.deepEqual(second.transcriptionChunks, [{ direction: "OUTPUT", text: "que sí" }]);

  const done = owner.observe(wire({ serverContent: { turnComplete: true } }));
  assert.deepEqual(done.events, [
    {
      type: "ASSISTANT_TRANSCRIPT_COMPLETED",
      transcript: "claro que sí",
      responseId: "gemini-response-1",
    },
    {
      type: "ASSISTANT_RESPONSE_COMPLETED",
      kind: "NORMAL",
      responseId: "gemini-response-1",
      status: "completed",
    },
  ]);
  assert.equal(done.snapshot.activeResponseId, null);
});

test("output transcript completion preserves response identity when model audio already owns the turn", () => {
  const owner = readyOwner();
  owner.observe(wire({ serverContent: { modelTurn: { parts: [{ text: "ignored wire shape" }] } } }));
  owner.observe(wire({ serverContent: { outputTranscription: { text: "hola" } } }));
  const done = owner.observe(wire({ serverContent: { turnComplete: true } }));
  assert.equal(done.events[0]?.type, "ASSISTANT_TRANSCRIPT_COMPLETED");
  assert.equal(done.events[0]?.responseId, "gemini-response-1");
  assert.equal(done.events[1]?.responseId, "gemini-response-1");
});

test("tool wait preserves call ids and submitting results releases protocol wait without creating a response", () => {
  const owner = readyOwner();
  const tool = owner.observe(wire({
    toolCall: {
      functionCalls: [
        { id: "fc-1", name: "search_reservation" },
        { id: "fc-2", name: "lookup_customer" },
      ],
    },
  }));

  assert.deepEqual(tool.events, [{
    type: "ASSISTANT_RESPONSE_STARTED",
    kind: "NORMAL",
    responseId: "gemini-response-1",
    purpose: "tool_call",
  }]);
  assert.equal(tool.snapshot.state, "TOOL_WAIT");
  assert.deepEqual(tool.snapshot.pendingToolCallIds, ["fc-1", "fc-2"]);

  assert.equal(owner.noteToolResponseSubmitted("fc-1").state, "TOOL_WAIT");
  const released = owner.noteToolResponseSubmitted("fc-2");
  assert.equal(released.state, "GENERATING");
  assert.equal(released.activeResponseId, "gemini-response-1");
});

test("function calls without correlation ids fail closed", () => {
  const owner = readyOwner();
  assert.throws(
    () => owner.observe(wire({ toolCall: { functionCalls: [{ name: "search_reservation" }] } })),
    /missing required correlation id/,
  );
});

test("normal interruption completes active response, discards partial output transcript and returns directly to READY", () => {
  const owner = readyOwner();
  owner.observe(wire({ serverContent: { modelTurn: { parts: [{ text: "hola" }] } } }));
  owner.observe(wire({ serverContent: { outputTranscription: { text: "transcript parcial" } } }));

  const interrupted = owner.observe(wire({ serverContent: { interrupted: true } }));
  assert.deepEqual(interrupted.events, [{
    type: "ASSISTANT_RESPONSE_COMPLETED",
    kind: "NORMAL",
    responseId: "gemini-response-1",
    status: "interrupted",
  }]);
  assert.equal(interrupted.events.some((event) => event.type === "ASSISTANT_TRANSCRIPT_COMPLETED"), false);
  assert.equal(interrupted.snapshot.activeResponseId, null);
  assert.deepEqual(interrupted.snapshot.pendingToolCallIds, []);
  assert.equal(interrupted.snapshot.state, "READY");

  const next = owner.observe(wire({ serverContent: { modelTurn: { parts: [{ text: "siguiente" }] } } }));
  assert.equal(next.events[0]?.responseId, "gemini-response-2");
  assert.equal(next.snapshot.state, "GENERATING");
  const nextDone = owner.observe(wire({ serverContent: { turnComplete: true } }));
  assert.equal(nextDone.events.some((event) => event.type === "ASSISTANT_TRANSCRIPT_COMPLETED"), false);
});

test("interruption completes the active neutral response once and cancellation is evidence, not rollback", () => {
  const owner = readyOwner();
  owner.observe(wire({ toolCall: { functionCalls: [{ id: "fc-9", name: "create_reservation" }] } }));

  const interrupted = owner.observe(wire({ serverContent: { interrupted: true } }));
  assert.deepEqual(interrupted.events, [{
    type: "ASSISTANT_RESPONSE_COMPLETED",
    kind: "NORMAL",
    responseId: "gemini-response-1",
    status: "interrupted",
  }]);
  assert.equal(interrupted.snapshot.state, "INTERRUPTED");
  assert.deepEqual(interrupted.snapshot.pendingToolCallIds, ["fc-9"]);

  const cancelled = owner.observe(wire({ toolCallCancellation: { ids: ["fc-9"] } }));
  assert.deepEqual(cancelled.events, []);
  assert.deepEqual(cancelled.cancelledToolCallIds, ["fc-9"]);
  assert.deepEqual(cancelled.snapshot.pendingToolCallIds, []);
  assert.equal(cancelled.snapshot.state, "READY");
});

test("turnComplete cannot release response ownership or transcript while tool calls are unresolved", () => {
  const owner = readyOwner();
  owner.observe(wire({ toolCall: { functionCalls: [{ id: "fc-pending", name: "search" }] } }));
  owner.observe(wire({ serverContent: { outputTranscription: { text: "espera" } } }));
  const done = owner.observe(wire({ serverContent: { turnComplete: true } }));
  assert.deepEqual(done.events, []);
  assert.equal(done.snapshot.state, "TOOL_WAIT");
  assert.equal(done.snapshot.activeResponseId, "gemini-response-1");
  assert.deepEqual(done.snapshot.pendingToolCallIds, ["fc-pending"]);
});

test("closed owner rejects later wire evidence and clears transient ownership", () => {
  const owner = readyOwner();
  owner.observe(wire({ serverContent: { modelTurn: { parts: [{ text: "hola" }] } } }));
  owner.observe(wire({ serverContent: { outputTranscription: { text: "hola" } } }));
  const closed = owner.close();
  assert.equal(closed.state, "CLOSED");
  assert.equal(closed.activeResponseId, null);
  assert.deepEqual(closed.pendingToolCallIds, []);
  assert.throws(() => owner.observe(wire({ serverContent: { turnComplete: true } })), /owner is closed/);
});
