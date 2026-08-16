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

test("synthetic: speech_started invalidates old silence epoch", () => {
  const m = new ConversationTurnLifecycle();
  const effects = startWaiting(m);
  const epoch = effects.find((e) => e.type === "ARM_SILENCE_TIMER").epoch;
  feed(m, { type: "input_audio_buffer.speech_started" });
  assert.equal(m.snapshot().state, "CALLER_SPEAKING");
  assert.equal(m.snapshot().silenceTimerArmed, false);
  assert.deepEqual(m.dispatch({ type: "silence_close_deadline", epoch }), []);
});

test("synthetic: long caller speech never triggers presence", () => {
  const m = new ConversationTurnLifecycle();
  const effects = startWaiting(m);
  const epoch = effects.find((e) => e.type === "ARM_SILENCE_TIMER").epoch;
  feed(m, { type: "input_audio_buffer.speech_started" });
  assert.deepEqual(m.dispatch({ type: "presence_deadline", epoch }), []);
  assert.equal(m.snapshot().state, "CALLER_SPEAKING");
});

test("synthetic: processing turn ignores stale silence close", () => {
  const m = new ConversationTurnLifecycle();
  const effects = startWaiting(m);
  const epoch = effects.find((e) => e.type === "ARM_SILENCE_TIMER").epoch;
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  feed(m, { type: "conversation.item.input_audio_transcription.completed", transcript: "Quiero reservar una mesa" });
  assert.equal(m.snapshot().state, "PROCESSING_CALLER_TURN");
  assert.deepEqual(m.dispatch({ type: "silence_close_deadline", epoch }), []);
});

test("synthetic: coherent tool resets ignored counter", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  feed(m, { type: "conversation.item.input_audio_transcription.completed", transcript: "bla bla" });
  feed(m, { type: "response.function_call_arguments.done", name: "restaurant_input_ignored", arguments: '{"reason":"INCOHERENT"}' });
  assert.equal(m.snapshot().ignoredCount, 1);
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  feed(m, { type: "conversation.item.input_audio_transcription.completed", transcript: "Cuál es vuestro horario" });
  const effects = feed(m, { type: "response.function_call_arguments.done", name: "restaurant_business_info", arguments: '{}' });
  assert.equal(m.snapshot().ignoredCount, 0);
  assert.ok(effects.some((e) => e.type === "RESET_IGNORED_COUNT"));
});

test("synthetic: SILENCE tool reason never increments semantic ignored count", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "response.function_call_arguments.done", name: "restaurant_input_ignored", arguments: '{"reason":"SILENCE"}' });
  assert.equal(m.snapshot().ignoredCount, 0);
  assert.equal(m.snapshot().state, "WAITING_FOR_CALLER");
});

test("synthetic: ignored #2 emits protected recovery and #3 terminal close", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  let e = feed(m, { type: "response.function_call_arguments.done", name: "restaurant_input_ignored", arguments: '{"reason":"BACKGROUND_SPEECH"}' });
  assert.equal(m.snapshot().ignoredCount, 1);
  e = feed(m, { type: "response.function_call_arguments.done", name: "restaurant_input_ignored", arguments: '{"reason":"ECHO"}' });
  assert.ok(e.some((x) => x.type === "SPEAK_IGNORED_RECOVERY" && x.protected === true));
  e = feed(m, { type: "response.function_call_arguments.done", name: "restaurant_input_ignored", arguments: '{"reason":"INCOHERENT"}' });
  assert.ok(e.some((x) => x.type === "SPEAK_TERMINAL_FAREWELL" && x.reason === "repeated_ignored_input"));
});

test("synthetic: out_of_scope is not ignored input", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  const effects = feed(m, { type: "response.function_call_arguments.done", name: "restaurant_out_of_scope", arguments: '{}' });
  assert.equal(m.snapshot().ignoredCount, 0);
  assert.equal(m.snapshot().state, "LUCIA_SPEAKING");
  assert.ok(!effects.some((e) => e.type === "IGNORED_COUNT_CHANGED"));
});

test("synthetic: handoff suspends conversational lifecycle", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  const effects = feed(m, { type: "response.function_call_arguments.done", name: "restaurant_human_assistance", arguments: '{}' });
  assert.equal(m.snapshot().state, "HANDOFF");
  assert.ok(effects.some((e) => e.type === "SUSPEND_FOR_HANDOFF"));
  assert.deepEqual(feed(m, { type: "input_audio_buffer.speech_started" }), []);
});

test("synthetic: end_call becomes terminal and hangup follows terminal audio stop", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  let effects = feed(m, { type: "response.function_call_arguments.done", name: "restaurant_end_call", arguments: '{"confirmed":true}' });
  assert.ok(effects.some((e) => e.type === "SPEAK_TERMINAL_FAREWELL"));
  feed(m, { type: "output_audio_buffer.started", response: { metadata: { purpose: "terminal_farewell" } } });
  effects = feed(m, { type: "output_audio_buffer.stopped", response: { metadata: { purpose: "terminal_farewell" } } });
  assert.ok(effects.some((e) => e.type === "HANGUP"));
  assert.equal(m.snapshot().state, "CLOSING");
});

test("synthetic: unusable transcript returns to fresh waiting epoch", () => {
  const m = new ConversationTurnLifecycle();
  const first = startWaiting(m);
  const epoch1 = first.find((e) => e.type === "ARM_SILENCE_TIMER").epoch;
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  const effects = feed(m, { type: "conversation.item.input_audio_transcription.completed", transcript: "   " });
  const arm = effects.find((e) => e.type === "ARM_SILENCE_TIMER");
  assert.ok(arm);
  assert.ok(arm.epoch > epoch1);
  assert.equal(m.snapshot().state, "WAITING_FOR_CALLER");
});
