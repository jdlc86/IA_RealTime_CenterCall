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

function epochFrom(effects) {
  return effects.find((e) => e.type === "ARM_SILENCE_TIMER")?.epoch;
}

function ignored(machine, reason) {
  return feed(machine, {
    type: "response.function_call_arguments.done",
    name: "restaurant_input_ignored",
    arguments: JSON.stringify({ reason }),
  });
}

test("adversarial: duplicated stale presence/close deadlines are idempotently ignored after speech", () => {
  const m = new ConversationTurnLifecycle();
  const epoch = epochFrom(startWaiting(m));
  feed(m, { type: "input_audio_buffer.speech_started" });
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(m.dispatch({ type: "presence_deadline", epoch }), []);
    assert.deepEqual(m.dispatch({ type: "silence_close_deadline", epoch }), []);
  }
  assert.equal(m.snapshot().state, "CALLER_SPEAKING");
});

test("adversarial: duplicated speech_started does not create new timers or regress state", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "input_audio_buffer.speech_started" });
  const before = m.snapshot();
  assert.deepEqual(feed(m, { type: "input_audio_buffer.speech_started" }), []);
  assert.deepEqual(m.snapshot(), before);
});

test("adversarial: duplicated speech_stopped is harmless while processing", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  const before = m.snapshot();
  assert.deepEqual(feed(m, { type: "input_audio_buffer.speech_stopped" }), []);
  assert.deepEqual(m.snapshot(), before);
});

test("adversarial: stale timer from previous turn cannot affect a later waiting epoch", () => {
  const m = new ConversationTurnLifecycle();
  const epoch1 = epochFrom(startWaiting(m));
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  feed(m, { type: "conversation.item.input_audio_transcription.completed", transcript: "horario" });
  feed(m, { type: "response.function_call_arguments.done", name: "restaurant_business_info", arguments: "{}" });
  feed(m, { type: "output_audio_buffer.started", response: { metadata: {} } });
  const epoch2 = epochFrom(feed(m, { type: "output_audio_buffer.stopped", response: { metadata: {} } }));
  assert.ok(epoch2 > epoch1);
  assert.deepEqual(m.dispatch({ type: "presence_deadline", epoch: epoch1 }), []);
  assert.deepEqual(m.dispatch({ type: "silence_close_deadline", epoch: epoch1 }), []);
  assert.equal(m.snapshot().state, "WAITING_FOR_CALLER");
});

test("adversarial: presence check cannot cause semantic reset or increment", () => {
  const m = new ConversationTurnLifecycle();
  const epoch = epochFrom(startWaiting(m));
  const effects = m.dispatch({ type: "presence_deadline", epoch });
  assert.ok(effects.some((e) => e.type === "SPEAK_PRESENCE_CHECK"));
  const before = m.snapshot();
  feed(m, { type: "output_audio_buffer.started", response: { metadata: { purpose: "presence_recovery_v18" } } });
  feed(m, { type: "output_audio_buffer.stopped", response: { metadata: { purpose: "presence_recovery_v18" } } });
  assert.equal(m.snapshot().ignoredCount, before.ignoredCount);
  assert.equal(m.snapshot().silenceEpoch, before.silenceEpoch);
});

test("adversarial: caller speech immediately after presence request still cancels silence close", () => {
  const m = new ConversationTurnLifecycle();
  const epoch = epochFrom(startWaiting(m));
  m.dispatch({ type: "presence_deadline", epoch });
  feed(m, { type: "input_audio_buffer.speech_started" });
  assert.equal(m.snapshot().state, "CALLER_SPEAKING");
  assert.deepEqual(m.dispatch({ type: "silence_close_deadline", epoch }), []);
});

test("adversarial: normal assistant audio shields against all silence deadlines", () => {
  const m = new ConversationTurnLifecycle();
  const epoch = epochFrom(startWaiting(m));
  feed(m, { type: "output_audio_buffer.started", response: { metadata: {} } });
  assert.equal(m.snapshot().state, "LUCIA_SPEAKING");
  assert.deepEqual(m.dispatch({ type: "presence_deadline", epoch }), []);
  assert.deepEqual(m.dispatch({ type: "silence_close_deadline", epoch }), []);
});

test("adversarial: terminal speaking ignores caller audio and stale semantic events", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "response.function_call_arguments.done", name: "restaurant_end_call", arguments: '{"confirmed":true}' });
  assert.equal(m.snapshot().state, "TERMINAL_SPEAKING");
  assert.deepEqual(feed(m, { type: "input_audio_buffer.speech_started" }), []);
  assert.deepEqual(feed(m, { type: "response.function_call_arguments.done", name: "restaurant_business_info", arguments: "{}" }), []);
  assert.equal(m.snapshot().state, "TERMINAL_SPEAKING");
});

test("adversarial: after CLOSING all events are ignored", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "response.function_call_arguments.done", name: "restaurant_end_call", arguments: '{"confirmed":true}' });
  feed(m, { type: "output_audio_buffer.started", response: { metadata: { purpose: "terminal_farewell" } } });
  feed(m, { type: "output_audio_buffer.stopped", response: { metadata: { purpose: "terminal_farewell" } } });
  assert.equal(m.snapshot().state, "CLOSING");
  const events = [
    { type: "input_audio_buffer.speech_started" },
    { type: "input_audio_buffer.speech_stopped" },
    { type: "conversation.item.input_audio_transcription.completed", transcript: "hola" },
    { type: "response.function_call_arguments.done", name: "restaurant_business_info", arguments: "{}" },
  ];
  for (const event of events) assert.deepEqual(feed(m, event), []);
});

test("adversarial: handoff remains authoritative despite late assistant or caller events", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "response.function_call_arguments.done", name: "restaurant_human_assistance", arguments: "{}" });
  const late = [
    { type: "input_audio_buffer.speech_started" },
    { type: "input_audio_buffer.speech_stopped" },
    { type: "conversation.item.input_audio_transcription.completed", transcript: "sigo aquí" },
    { type: "output_audio_buffer.started", response: { metadata: {} } },
    { type: "output_audio_buffer.stopped", response: { metadata: {} } },
  ];
  for (const event of late) assert.deepEqual(feed(m, event), []);
  assert.equal(m.snapshot().state, "HANDOFF");
});

test("adversarial: repeated SILENCE never accumulates semantic ignored count", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  for (let i = 0; i < 10; i++) ignored(m, "SILENCE");
  assert.equal(m.snapshot().ignoredCount, 0);
  assert.equal(m.snapshot().state, "WAITING_FOR_CALLER");
});

test("adversarial: unknown ignored reason does not count toward terminal threshold", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  ignored(m, "LOW_CONFIDENCE_AUDIO_ARTIFACT");
  ignored(m, "LOW_CONFIDENCE_AUDIO_ARTIFACT");
  ignored(m, "LOW_CONFIDENCE_AUDIO_ARTIFACT");
  assert.equal(m.snapshot().ignoredCount, 0);
  assert.equal(m.snapshot().state, "WAITING_FOR_CALLER");
});

test("adversarial: counted ignored reasons are consecutive and valid turn clears history", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  ignored(m, "BACKGROUND_SPEECH");
  assert.equal(m.snapshot().ignoredCount, 1);
  feed(m, { type: "response.function_call_arguments.done", name: "restaurant_business_info", arguments: "{}" });
  assert.equal(m.snapshot().ignoredCount, 0);
  ignored(m, "ECHO");
  assert.equal(m.snapshot().ignoredCount, 1);
  assert.notEqual(m.snapshot().state, "TERMINAL_SPEAKING");
});

test("adversarial: OUT_OF_SCOPE clears prior incoherence rather than counting it", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  ignored(m, "INCOHERENT");
  assert.equal(m.snapshot().ignoredCount, 1);
  feed(m, { type: "response.function_call_arguments.done", name: "restaurant_out_of_scope", arguments: "{}" });
  assert.equal(m.snapshot().ignoredCount, 0);
  assert.equal(m.snapshot().state, "LUCIA_SPEAKING");
});

test("adversarial: max call duration wins from caller speaking", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "input_audio_buffer.speech_started" });
  const effects = m.dispatch({ type: "max_call_duration" });
  assert.equal(m.snapshot().state, "TERMINAL_SPEAKING");
  assert.ok(effects.some((e) => e.type === "SPEAK_TERMINAL_FAREWELL" && e.reason === "max_call_duration"));
});

test("adversarial: max call duration wins from processing", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  const effects = m.dispatch({ type: "max_call_duration" });
  assert.equal(m.snapshot().state, "TERMINAL_SPEAKING");
  assert.ok(effects.some((e) => e.type === "SPEAK_TERMINAL_FAREWELL"));
});

test("adversarial: unusable transcript cannot resurrect an old silence epoch", () => {
  const m = new ConversationTurnLifecycle();
  const epoch1 = epochFrom(startWaiting(m));
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  const effects = feed(m, { type: "conversation.item.input_audio_transcription.completed", transcript: "" });
  const epoch2 = epochFrom(effects);
  assert.ok(epoch2 > epoch1);
  assert.deepEqual(m.dispatch({ type: "silence_close_deadline", epoch: epoch1 }), []);
});

test("adversarial: semantic tool before stale transcription cannot be undone by later unusable transcript", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  feed(m, { type: "input_audio_buffer.speech_started" });
  feed(m, { type: "input_audio_buffer.speech_stopped" });
  feed(m, { type: "response.function_call_arguments.done", name: "restaurant_business_info", arguments: "{}" });
  assert.equal(m.snapshot().state, "LUCIA_SPEAKING");
  feed(m, { type: "conversation.item.input_audio_transcription.completed", transcript: "" });
  assert.equal(m.snapshot().state, "LUCIA_SPEAKING");
});

test("adversarial: third ignored input creates terminal state and fourth ignored is inert", () => {
  const m = new ConversationTurnLifecycle();
  startWaiting(m);
  ignored(m, "INCOHERENT");
  ignored(m, "BACKGROUND_SPEECH");
  ignored(m, "ECHO");
  assert.equal(m.snapshot().state, "TERMINAL_SPEAKING");
  assert.deepEqual(ignored(m, "INCOHERENT"), []);
  assert.equal(m.snapshot().ignoredCount, 3);
});

test("adversarial: presence deadline is one-shot within same silence epoch", () => {
  const m = new ConversationTurnLifecycle();
  const epoch = epochFrom(startWaiting(m));
  const first = m.dispatch({ type: "presence_deadline", epoch });
  const second = m.dispatch({ type: "presence_deadline", epoch });
  assert.equal(first.filter((e) => e.type === "SPEAK_PRESENCE_CHECK").length, 1);
  assert.deepEqual(second, []);
});

test("adversarial: silence close still works after one presence check if caller remains silent", () => {
  const m = new ConversationTurnLifecycle();
  const epoch = epochFrom(startWaiting(m));
  m.dispatch({ type: "presence_deadline", epoch });
  const effects = m.dispatch({ type: "silence_close_deadline", epoch });
  assert.equal(m.snapshot().state, "TERMINAL_SPEAKING");
  assert.ok(effects.some((e) => e.type === "SPEAK_TERMINAL_FAREWELL" && e.reason === "silence_timeout"));
});
