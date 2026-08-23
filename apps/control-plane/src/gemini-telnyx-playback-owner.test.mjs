import assert from "node:assert/strict";
import test from "node:test";
import { GeminiTelnyxPlaybackOwner } from "../.test-dist/gemini-telnyx-playback-owner.js";

test("first queued audio starts playback exactly once for one response", () => {
  const owner = new GeminiTelnyxPlaybackOwner();
  assert.deepEqual(owner.observeAudioQueued("r1", "NORMAL"), [
    { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "r1" },
  ]);
  assert.deepEqual(owner.observeAudioQueued("r1", "NORMAL"), []);
  assert.throws(() => owner.observeAudioQueued("r2", "NORMAL"), /already owned by r1/);
});

test("drain mark echo is the only normal playback-stop evidence", () => {
  const owner = new GeminiTelnyxPlaybackOwner();
  owner.observeAudioQueued("r1", "NORMAL");
  const mark = owner.requestDrainMark("r1");
  assert.deepEqual(owner.observeReturnedMark("unrelated"), []);
  assert.deepEqual(owner.observeReturnedMark(mark), [
    { type: "ASSISTANT_AUDIO_STOPPED", kind: "NORMAL", responseId: "r1" },
  ]);
  assert.equal(owner.snapshot().responseId, null);
});

test("clear mark echo becomes AUDIO_CLEARED and never AUDIO_STOPPED", () => {
  const owner = new GeminiTelnyxPlaybackOwner();
  owner.observeAudioQueued("greeting-1", "GREETING");
  const mark = owner.requestClearMark("greeting-1");
  assert.deepEqual(owner.observeReturnedMark(mark), [
    { type: "ASSISTANT_AUDIO_CLEARED", kind: "GREETING", responseId: "greeting-1" },
  ]);
  assert.equal(owner.snapshot().responseId, null);
});

test("playback mark requests require active correlated response and are one-shot", () => {
  const owner = new GeminiTelnyxPlaybackOwner();
  assert.throws(() => owner.requestDrainMark("r1"), /requires active response/);
  owner.observeAudioQueued("r1", "NORMAL");
  owner.requestDrainMark("r1");
  assert.throws(() => owner.requestClearMark("r1"), /already awaits mark/);
  assert.throws(() => owner.requestDrainMark("r2"), /requires active response r2/);
});
