import test from "node:test";
import assert from "node:assert/strict";
import { ConversationTurnLifecycle } from "../.test-dist/conversation-turn-lifecycle.js";
import { adaptRealtimeTurnEvent } from "../.test-dist/realtime-turn-lifecycle-adapter.js";

function feed(machine, providerEvent) {
  const effects = [];
  for (const event of adaptRealtimeTurnEvent(providerEvent)) effects.push(...machine.dispatch(event));
  return effects;
}

function startWaiting(machine) {
  feed(machine, { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL" });
  return feed(machine, { type: "ASSISTANT_AUDIO_STOPPED", kind: "NORMAL" });
}

test("provider-neutral: caller speech invalidates old presence epoch before processing", () => {
  const m = new ConversationTurnLifecycle();
  const arm = startWaiting(m).find((e) => e.type === "ARM_SILENCE_TIMER");
  feed(m, { type: "CALLER_SPEECH_STARTED" });
  feed(m, { type: "CALLER_SPEECH_STOPPED" });
  feed(m, { type: "CALLER_TRANSCRIPT_COMPLETED", transcript: "¿A qué hora cerráis hoy?" });
  assert.equal(m.snapshot().state, "PROCESSING_CALLER_TURN");
  assert.deepEqual(m.dispatch({ type: "presence_deadline", epoch: arm.epoch }), []);
});

test("provider-neutral: unusable transcript returns to fresh waiting epoch", () => {
  const m = new ConversationTurnLifecycle();
  const first = startWaiting(m).find((e) => e.type === "ARM_SILENCE_TIMER").epoch;
  feed(m, { type: "CALLER_SPEECH_STARTED" });
  feed(m, { type: "CALLER_SPEECH_STOPPED" });
  const effects = feed(m, { type: "CALLER_TRANSCRIPT_COMPLETED", transcript: "   " });
  const next = effects.find((e) => e.type === "ARM_SILENCE_TIMER").epoch;
  assert.ok(next > first);
  assert.deepEqual(m.dispatch({ type: "presence_deadline", epoch: first }), []);
});

test("provider-neutral: business tool is coherent semantic activity", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "CALLER_SPEECH_STARTED" });
  feed(m, { type: "CALLER_SPEECH_STOPPED" });
  feed(m, { type: "CALLER_TRANSCRIPT_COMPLETED", transcript: "horario" });
  feed(m, { type: "SEMANTIC_TOOL_SELECTED", name: "restaurant_business_info", arguments: "{}" });
  assert.equal(m.snapshot().state, "LUCIA_SPEAKING");
  assert.equal(m.snapshot().silenceTimerArmed, false);
});

test("provider-neutral: model end-call selection is semantic only until v41 authorizes terminal action", () => {
  const events = adaptRealtimeTurnEvent({ type: "SEMANTIC_TOOL_SELECTED", name: "restaurant_end_call", arguments: '{"confirmed":true}' });
  assert.deepEqual(events, [{ type: "semantic_valid", tool: "restaurant_end_call" }]);
});

test("provider-neutral: model human-assistance selection is semantic only until v43/v37 authorize transport", () => {
  const events = adaptRealtimeTurnEvent({ type: "SEMANTIC_TOOL_SELECTED", name: "restaurant_human_assistance", arguments: '{"reason":"SYSTEM_LIMITATION"}' });
  assert.deepEqual(events, [{ type: "semantic_valid", tool: "restaurant_human_assistance" }]);
});

test("Gate B: handoff speech remains lifecycle-compatible while v40/v44 see its protected kind", () => {
  assert.deepEqual(
    adaptRealtimeTurnEvent({ type: "ASSISTANT_AUDIO_STARTED", kind: "HANDOFF", responseId: "handoff-1" }),
    [{ type: "assistant_audio_started", kind: "NORMAL" }],
  );
  assert.deepEqual(
    adaptRealtimeTurnEvent({ type: "ASSISTANT_AUDIO_STOPPED", kind: "HANDOFF", responseId: "handoff-1" }),
    [{ type: "assistant_audio_stopped", kind: "NORMAL" }],
  );
});
