import test from "node:test";
import assert from "node:assert/strict";
import { TelnyxPlaybackOwner } from "./playback.mjs";

test("playback identity must be bound before audio is queued", () => {
  const owner = new TelnyxPlaybackOwner();
  assert.throws(() => owner.noteAudioQueued("gemini-response-1"), /identity mismatch/);
  owner.bindResponse("gemini-response-1");
  assert.equal(owner.noteAudioQueued("gemini-response-1").first, true);
  assert.equal(owner.noteAudioQueued("gemini-response-1").first, false);
  assert.throws(() => owner.bindResponse("gemini-response-2"), /already owned/);
});

test("drain mark echo is the only normal playback stop evidence", () => {
  const owner = new TelnyxPlaybackOwner();
  owner.bindResponse("gemini-response-1");
  owner.noteAudioQueued("gemini-response-1");
  const mark = owner.requestDrainMark("gemini-response-1");
  assert.equal(owner.observeReturnedMark("unrelated"), null);
  assert.deepEqual(owner.observeReturnedMark(mark), { type: "ASSISTANT_AUDIO_STOPPED", responseId: "gemini-response-1" });
  assert.equal(owner.activeResponseId(), null);
});

test("clear mark yields cleared rather than stopped", () => {
  const owner = new TelnyxPlaybackOwner();
  owner.bindResponse("gemini-response-1");
  owner.noteAudioQueued("gemini-response-1");
  const mark = owner.requestClearMark("gemini-response-1");
  assert.deepEqual(owner.observeReturnedMark(mark), { type: "ASSISTANT_AUDIO_CLEARED", responseId: "gemini-response-1" });
});
