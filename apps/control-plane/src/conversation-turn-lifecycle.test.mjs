import test from "node:test";
import assert from "node:assert/strict";
import { ConversationTurnLifecycle } from "../.test-dist/conversation-turn-lifecycle.js";

function startWaiting(lifecycle) {
  lifecycle.dispatch({ type: "assistant_audio_stopped", kind: "NORMAL" });
  return lifecycle.snapshot().silenceEpoch;
}

function effectTypes(effects) {
  return effects.map((effect) => effect.type);
}

test("CTL-01 normal turn cancels silence and reaches Lucia speaking", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  const oldEpoch = l.snapshot().silenceEpoch;
  assert.deepEqual(effectTypes(l.dispatch({ type: "speech_started" })), ["CANCEL_SILENCE_TIMER"]);
  l.dispatch({ type: "speech_stopped" });
  l.dispatch({ type: "transcript_usable" });
  l.dispatch({ type: "semantic_valid", tool: "restaurant_business_info" });
  assert.equal(l.snapshot().state, "LUCIA_SPEAKING");
  assert.equal(l.snapshot().silenceTimerArmed, false);
  assert.deepEqual(l.dispatch({ type: "silence_close_deadline", epoch: oldEpoch }), []);
});

test("CTL-02/03 genuine silence gets one presence check then terminal close", () => {
  const l = new ConversationTurnLifecycle();
  const epoch = startWaiting(l);
  assert.deepEqual(effectTypes(l.dispatch({ type: "presence_deadline", epoch })), ["SPEAK_PRESENCE_CHECK"]);
  assert.deepEqual(l.dispatch({ type: "presence_deadline", epoch }), []);
  assert.deepEqual(effectTypes(l.dispatch({ type: "silence_close_deadline", epoch })), ["CANCEL_SILENCE_TIMER", "SPEAK_TERMINAL_FAREWELL"]);
  assert.equal(l.snapshot().state, "TERMINAL_SPEAKING");
  assert.deepEqual(effectTypes(l.dispatch({ type: "assistant_audio_stopped", kind: "TERMINAL" })), ["HANGUP"]);
  assert.equal(l.snapshot().state, "CLOSING");
});

test("CTL-04/05 caller speech wins against presence deadline", () => {
  const l = new ConversationTurnLifecycle();
  const epoch = startWaiting(l);
  l.dispatch({ type: "speech_started" });
  assert.equal(l.snapshot().state, "CALLER_SPEAKING");
  assert.deepEqual(l.dispatch({ type: "presence_deadline", epoch }), []);
});

test("CTL-06 long caller speech cannot trigger silence close", () => {
  const l = new ConversationTurnLifecycle();
  const epoch = startWaiting(l);
  l.dispatch({ type: "speech_started" });
  assert.deepEqual(l.dispatch({ type: "silence_close_deadline", epoch }), []);
  assert.equal(l.snapshot().state, "CALLER_SPEAKING");
});

test("CTL-07 processing caller turn has no silence timer", () => {
  const l = new ConversationTurnLifecycle();
  const epoch = startWaiting(l);
  l.dispatch({ type: "speech_started" });
  l.dispatch({ type: "speech_stopped" });
  l.dispatch({ type: "transcript_usable" });
  assert.equal(l.snapshot().state, "PROCESSING_CALLER_TURN");
  assert.equal(l.snapshot().silenceTimerArmed, false);
  assert.deepEqual(l.dispatch({ type: "silence_close_deadline", epoch }), []);
});

test("CTL-08 unusable transcript starts a fresh silence episode", () => {
  const l = new ConversationTurnLifecycle();
  const firstEpoch = startWaiting(l);
  l.dispatch({ type: "speech_started" });
  l.dispatch({ type: "speech_stopped" });
  const effects = l.dispatch({ type: "transcript_unusable" });
  assert.deepEqual(effectTypes(effects), ["ARM_SILENCE_TIMER"]);
  assert.equal(l.snapshot().state, "WAITING_FOR_CALLER");
  assert.notEqual(l.snapshot().silenceEpoch, firstEpoch);
  assert.deepEqual(l.dispatch({ type: "silence_close_deadline", epoch: firstEpoch }), []);
});

test("CTL-09/10 first counted ignored input is tolerated", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  l.dispatch({ type: "speech_started" });
  l.dispatch({ type: "speech_stopped" });
  const effects = l.dispatch({ type: "semantic_ignored", reason: "BACKGROUND_SPEECH" });
  assert.equal(l.snapshot().ignoredCount, 1);
  assert.equal(l.snapshot().state, "WAITING_FOR_CALLER");
  assert.ok(effectTypes(effects).includes("IGNORED_COUNT_CHANGED"));
  assert.ok(!effectTypes(effects).includes("SPEAK_IGNORED_RECOVERY"));
});

test("CTL-11 second consecutive ignored input produces protected recovery", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  l.dispatch({ type: "semantic_ignored", reason: "INCOHERENT" });
  const effects = l.dispatch({ type: "semantic_ignored", reason: "ECHO" });
  assert.equal(l.snapshot().ignoredCount, 2);
  assert.equal(l.snapshot().state, "IGNORED_RECOVERY_SPEAKING");
  assert.ok(effectTypes(effects).includes("SPEAK_IGNORED_RECOVERY"));
});

test("CTL-12 third consecutive ignored input produces terminal farewell", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  l.dispatch({ type: "semantic_ignored", reason: "INCOHERENT" });
  l.dispatch({ type: "semantic_ignored", reason: "BACKGROUND_SPEECH" });
  const effects = l.dispatch({ type: "semantic_ignored", reason: "NOT_DIRECTED_TO_ASSISTANT" });
  assert.equal(l.snapshot().ignoredCount, 3);
  assert.equal(l.snapshot().state, "TERMINAL_SPEAKING");
  assert.ok(effectTypes(effects).includes("SPEAK_TERMINAL_FAREWELL"));
});

test("CTL-13 coherent semantic turn resets ignored count", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  l.dispatch({ type: "semantic_ignored", reason: "INCOHERENT" });
  const effects = l.dispatch({ type: "semantic_valid", tool: "restaurant_business_info" });
  assert.equal(l.snapshot().ignoredCount, 0);
  assert.ok(effectTypes(effects).includes("RESET_IGNORED_COUNT"));
});

test("CTL-13b normal coherent assistant response also resets ignored count", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  l.dispatch({ type: "semantic_ignored", reason: "INCOHERENT" });
  l.dispatch({ type: "speech_started" });
  l.dispatch({ type: "speech_stopped" });
  l.dispatch({ type: "transcript_usable" });
  const effects = l.dispatch({ type: "assistant_audio_started", kind: "NORMAL" });
  assert.equal(l.snapshot().ignoredCount, 0);
  assert.equal(l.snapshot().state, "LUCIA_SPEAKING");
  assert.ok(effectTypes(effects).includes("RESET_IGNORED_COUNT"));
});

test("CTL-14 out of scope is coherent and does not increment ignored", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  l.dispatch({ type: "out_of_scope" });
  assert.equal(l.snapshot().ignoredCount, 0);
  assert.equal(l.snapshot().state, "LUCIA_SPEAKING");
});

test("CTL-16 SILENCE never increments semantic ignored count", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  l.dispatch({ type: "semantic_ignored", reason: "SILENCE" });
  assert.equal(l.snapshot().ignoredCount, 0);
  assert.equal(l.snapshot().state, "WAITING_FOR_CALLER");
});

test("CTL-17 normal Lucia speech remains normal lifecycle speech", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  l.dispatch({ type: "semantic_valid" });
  l.dispatch({ type: "assistant_audio_started", kind: "NORMAL" });
  assert.equal(l.snapshot().state, "LUCIA_SPEAKING");
});

test("CTL-19 protected recovery returns to fresh waiting interval after playback", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  l.dispatch({ type: "semantic_ignored", reason: "INCOHERENT" });
  l.dispatch({ type: "semantic_ignored", reason: "ECHO" });
  const before = l.snapshot().silenceEpoch;
  l.dispatch({ type: "assistant_audio_started", kind: "RECOVERY" });
  const effects = l.dispatch({ type: "assistant_audio_stopped", kind: "RECOVERY" });
  assert.equal(l.snapshot().state, "WAITING_FOR_CALLER");
  assert.ok(l.snapshot().silenceEpoch > before);
  assert.ok(effectTypes(effects).includes("ARM_SILENCE_TIMER"));
});

test("CTL-20 end_call owns terminal speech and hangup", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  assert.ok(effectTypes(l.dispatch({ type: "end_call" })).includes("SPEAK_TERMINAL_FAREWELL"));
  assert.equal(l.snapshot().state, "TERMINAL_SPEAKING");
  assert.deepEqual(effectTypes(l.dispatch({ type: "assistant_audio_stopped", kind: "TERMINAL" })), ["HANGUP"]);
});

test("CTL-21/22/23 handoff suspends conversation lifecycle", () => {
  const l = new ConversationTurnLifecycle();
  const epoch = startWaiting(l);
  assert.deepEqual(effectTypes(l.dispatch({ type: "handoff_started" })), ["CANCEL_SILENCE_TIMER", "SUSPEND_FOR_HANDOFF"]);
  assert.equal(l.snapshot().state, "HANDOFF");
  assert.deepEqual(l.dispatch({ type: "silence_close_deadline", epoch }), []);
  assert.deepEqual(l.dispatch({ type: "semantic_ignored", reason: "INCOHERENT" }), []);
});

test("CTL-24 max call guard is independent and terminal", () => {
  const l = new ConversationTurnLifecycle();
  startWaiting(l);
  const effects = l.dispatch({ type: "max_call_duration" });
  assert.ok(effectTypes(effects).includes("SPEAK_TERMINAL_FAREWELL"));
  assert.equal(l.snapshot().state, "TERMINAL_SPEAKING");
});

test("CTL-26 presence speech does not alter semantic counters or create new epoch", () => {
  const l = new ConversationTurnLifecycle();
  const epoch = startWaiting(l);
  l.dispatch({ type: "presence_deadline", epoch });
  l.dispatch({ type: "assistant_audio_started", kind: "PRESENCE" });
  l.dispatch({ type: "assistant_audio_stopped", kind: "PRESENCE" });
  assert.equal(l.snapshot().silenceEpoch, epoch);
  assert.equal(l.snapshot().ignoredCount, 0);
  assert.equal(l.snapshot().state, "WAITING_FOR_CALLER");
});

test("CTL-28/29/30 stale silence timers are harmless", () => {
  const l = new ConversationTurnLifecycle();
  const epoch = startWaiting(l);
  l.dispatch({ type: "speech_started" });
  assert.deepEqual(l.dispatch({ type: "silence_close_deadline", epoch }), []);
  l.dispatch({ type: "speech_stopped" });
  l.dispatch({ type: "semantic_valid" });
  assert.deepEqual(l.dispatch({ type: "silence_close_deadline", epoch }), []);
  l.dispatch({ type: "assistant_audio_started", kind: "NORMAL" });
  assert.deepEqual(l.dispatch({ type: "silence_close_deadline", epoch }), []);
});
