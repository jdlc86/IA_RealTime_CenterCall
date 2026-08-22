import test from "node:test";
import assert from "node:assert/strict";
import { ConversationTurnLifecycle } from "../.test-dist/conversation-turn-lifecycle.js";

function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const ignoredReasons = ["INCOHERENT","BACKGROUND_SPEECH","NOT_DIRECTED_TO_ASSISTANT","ECHO","UNCERTAIN","SILENCE","UNKNOWN"];

function randomEvent(rng, snapshot) {
  const epoch = snapshot.silenceEpoch;
  const stale = Math.max(0, epoch - 1);
  const events = [
    { type: "assistant_audio_started", kind: "NORMAL" },
    { type: "assistant_audio_started", kind: "RECOVERY" },
    { type: "assistant_audio_started", kind: "TERMINAL" },
    { type: "assistant_audio_started", kind: "PRESENCE" },
    { type: "assistant_audio_stopped", kind: "NORMAL" },
    { type: "assistant_audio_stopped", kind: "RECOVERY" },
    { type: "assistant_audio_stopped", kind: "TERMINAL" },
    { type: "assistant_audio_stopped", kind: "PRESENCE" },
    { type: "speech_started" },
    { type: "speech_stopped" },
    { type: "transcript_usable" },
    { type: "transcript_unusable" },
    { type: "semantic_valid", tool: "restaurant_business_info" },
    { type: "semantic_ignored", reason: ignoredReasons[Math.floor(rng()*ignoredReasons.length)] },
    { type: "out_of_scope" },
    { type: "presence_deadline", epoch },
    { type: "presence_deadline", epoch: stale },
    { type: "silence_close_deadline", epoch },
    { type: "silence_close_deadline", epoch: stale },
    { type: "acoustic_guard_expired" },
    { type: "processing_guard_expired" },
    { type: "handoff_started" },
    { type: "end_call" },
    { type: "max_call_duration" },
  ];
  return events[Math.floor(rng()*events.length)];
}

function assertInvariants(before, event, effects, after) {
  if (before.state === "CLOSING") {
    assert.deepEqual(effects, []);
    assert.equal(after.state, "CLOSING");
  }
  if (before.state === "HANDOFF" && event.type !== "max_call_duration") {
    assert.deepEqual(effects, []);
    assert.equal(after.state, "HANDOFF");
  }
  if (before.state === "TERMINAL_SPEAKING") {
    if (event.type === "assistant_audio_stopped" && event.kind === "TERMINAL") {
      assert.equal(after.state, "CLOSING");
      assert.ok(effects.some(e => e.type === "HANGUP"));
    } else {
      assert.deepEqual(effects, []);
      assert.equal(after.state, "TERMINAL_SPEAKING");
    }
  }
  if (before.state !== "WAITING_FOR_CALLER") {
    assert.ok(!effects.some(e => e.type === "SPEAK_PRESENCE_CHECK"));
  }
  if (effects.some(e => e.type === "HANGUP")) {
    assert.equal(after.state, "CLOSING");
  }
  if (after.state === "CLOSING") {
    assert.equal(after.silenceTimerArmed, false);
  }
  if (event.type === "semantic_ignored" && event.reason === "SILENCE") {
    assert.equal(after.ignoredCount, before.ignoredCount);
  }
  if ((event.type === "presence_deadline" || event.type === "silence_close_deadline") && event.epoch !== before.silenceEpoch) {
    assert.ok(!effects.some(e => e.type === "SPEAK_PRESENCE_CHECK" || e.type === "SPEAK_TERMINAL_FAREWELL"));
  }
}

test("fuzz: 200 deterministic random traces preserve lifecycle invariants", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rng = mulberry32(seed);
    const m = new ConversationTurnLifecycle();
    for (let i = 0; i < 250; i++) {
      const before = m.snapshot();
      const event = randomEvent(rng, before);
      const effects = m.dispatch(event);
      const after = m.snapshot();
      assertInvariants(before, event, effects, after);
    }
  }
});

test("fuzz: terminal state is absorbing under 10k random events until terminal audio stop", () => {
  const m = new ConversationTurnLifecycle();
  m.dispatch({ type: "end_call" });
  assert.equal(m.snapshot().state, "TERMINAL_SPEAKING");
  const rng = mulberry32(0xC0FFEE);
  for (let i = 0; i < 10000; i++) {
    const before = m.snapshot();
    let event = randomEvent(rng, before);
    if (event.type === "assistant_audio_stopped" && event.kind === "TERMINAL") event = { type: "speech_started" };
    const effects = m.dispatch(event);
    assert.deepEqual(effects, []);
    assert.equal(m.snapshot().state, "TERMINAL_SPEAKING");
  }
  const effects = m.dispatch({ type: "assistant_audio_stopped", kind: "TERMINAL" });
  assert.ok(effects.some(e => e.type === "HANGUP"));
  assert.equal(m.snapshot().state, "CLOSING");
});
