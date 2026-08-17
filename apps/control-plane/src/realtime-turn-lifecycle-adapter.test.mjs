import test from "node:test";
import assert from "node:assert/strict";
import { ConversationTurnLifecycle } from "../.test-dist/conversation-turn-lifecycle.js";
import { adaptRealtimeTurnEvent } from "../.test-dist/realtime-turn-lifecycle-adapter.js";

function feed(machine, realtimeEvent) {
  const effects = [];
  for (const event of adaptRealtimeTurnEvent(realtimeEvent)) effects.push(...machine.dispatch(event));
  return effects;
}

function startWaiting(machine) {
  feed(machine, { type: "output_audio_buffer.started", response: { metadata: {} } });
  return feed(machine, { type: "output_audio_buffer.stopped", response: { metadata: {} } });
}

test("realtime: caller speech invalidates old presence epoch before processing", () => {
  const m = new ConversationTurnLifecycle();
  const arm = startWaiting(m).find((e) => e.type === "ARM_SILENCE_TIMER");
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  feed(m, { type: "conversation.item.input_audio_transcription.completed", transcript: "¿A qué hora cerráis hoy?" });
  assert.equal(m.snapshot().state, "PROCESSING_CALLER_TURN");
  assert.deepEqual(m.dispatch({ type: "presence_deadline", epoch: arm.epoch }), []);
});

test("realtime: unusable transcript returns to fresh waiting epoch", () => {
  const m = new ConversationTurnLifecycle();
  const first = startWaiting(m).find((e) => e.type === "ARM_SILENCE_TIMER").epoch;
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  const effects = feed(m, { type: "conversation.item.input_audio_transcription.completed", transcript: "   " });
  const next = effects.find((e) => e.type === "ARM_SILENCE_TIMER").epoch;
  assert.ok(next > first);
  assert.deepEqual(m.dispatch({ type: "presence_deadline", epoch: first }), []);
});

test("realtime: business tool is coherent semantic activity", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  feed(m, { type: "conversation.item.input_audio_transcription.completed", transcript: "horario" });
  feed(m, { type: "response.function_call_arguments.done", name: "restaurant_business_info", arguments: "{}" });
  assert.equal(m.snapshot().state, "LUCIA_SPEAKING");
  assert.equal(m.snapshot().silenceTimerArmed, false);
});

test("realtime: model end-call selection is semantic only until v41 authorizes terminal action", () => {
  const events = adaptRealtimeTurnEvent({
    type: "response.function_call_arguments.done",
    name: "restaurant_end_call",
    arguments: '{"confirmed":true}',
  });
  assert.deepEqual(events, [{ type: "semantic_valid", tool: "restaurant_end_call" }]);
});

test("realtime: model human-assistance selection is semantic only until v43/v37 authorize transport", () => {
  const events = adaptRealtimeTurnEvent({
    type: "response.function_call_arguments.done",
    name: "restaurant_human_assistance",
    arguments: '{"reason":"SYSTEM_LIMITATION"}',
  });
  assert.deepEqual(events, [{ type: "semantic_valid", tool: "restaurant_human_assistance" }]);
});
