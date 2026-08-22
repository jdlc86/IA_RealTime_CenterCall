import test from "node:test";
import assert from "node:assert/strict";
import {
  initialCallerTurnFragmentState,
  observeCallerSpeechStarted,
  observeCallerTranscriptCompleted,
} from "../.test-dist/caller-turn-fragment-coordinator.js";

test("split VAD fragments become one semantic caller turn without timers", () => {
  let state = initialCallerTurnFragmentState();
  state = observeCallerSpeechStarted(state, "item-a");
  state = observeCallerSpeechStarted(state, "item-b");

  const first = observeCallerTranscriptCompleted(state, {
    itemId: "item-a",
    transcript: "Quiero reservar mañana",
  });
  assert.equal(first.action, "DEFER");
  state = first.next;

  const second = observeCallerTranscriptCompleted(state, {
    itemId: "item-b",
    transcript: "a las nueve para cinco personas",
  });
  assert.equal(second.action, "FORWARD");
  assert.equal(second.fragmentCount, 2);
  assert.equal(second.transcript, "Quiero reservar mañana a las nueve para cinco personas");
  assert.deepEqual(second.next.deferredFragments, []);
});

test("separate completed turns are never merged", () => {
  let state = initialCallerTurnFragmentState();
  state = observeCallerSpeechStarted(state, "item-a");
  const first = observeCallerTranscriptCompleted(state, { itemId: "item-a", transcript: "Hola" });
  assert.equal(first.action, "FORWARD");
  assert.equal(first.transcript, "Hola");

  state = observeCallerSpeechStarted(first.next, "item-b");
  const second = observeCallerTranscriptCompleted(state, { itemId: "item-b", transcript: "Quiero reservar" });
  assert.equal(second.action, "FORWARD");
  assert.equal(second.fragmentCount, 1);
  assert.equal(second.transcript, "Quiero reservar");
});

test("an older fragment is deferred only when a newer speech item is already active", () => {
  let state = initialCallerTurnFragmentState();
  state = observeCallerSpeechStarted(state, "item-a");
  const completed = observeCallerTranscriptCompleted(state, { itemId: "item-a", transcript: "mañana a las nueve" });
  assert.equal(completed.action, "FORWARD");
  assert.equal(completed.fragmentCount, 1);
});
