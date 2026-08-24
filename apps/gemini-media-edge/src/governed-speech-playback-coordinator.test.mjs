import test from "node:test";
import assert from "node:assert/strict";
import { GovernedSpeechPlaybackCoordinator } from "./governed-speech-playback-coordinator.mjs";

test("governed speech coordinator owns one correlated response through synthesis and playback", () => {
  const coordinator = new GovernedSpeechPlaybackCoordinator();
  assert.deepEqual(coordinator.reserve("speech-1"), { pendingResponseId: "speech-1", activeResponseId: null });
  assert.throws(() => coordinator.reserve("speech-2"), /already owns speech-1/);
  assert.throws(() => coordinator.assertProviderAudioAllowed(), /forbidden/);

  assert.deepEqual(coordinator.beginPlayback("speech-1"), { pendingResponseId: null, activeResponseId: "speech-1" });
  assert.throws(() => coordinator.assertProviderAudioAllowed(), /forbidden/);
  assert.equal(coordinator.observePlaybackEvent({ type: "ASSISTANT_AUDIO_STARTED", responseId: "speech-1" }), false);
  assert.equal(coordinator.observePlaybackEvent({ type: "ASSISTANT_AUDIO_STOPPED", responseId: "speech-1" }), true);
  assert.deepEqual(coordinator.snapshot(), { pendingResponseId: null, activeResponseId: null });
  assert.doesNotThrow(() => coordinator.assertProviderAudioAllowed());
});

test("governed speech coordinator fails closed on identity mismatch and clears on reset", () => {
  const coordinator = new GovernedSpeechPlaybackCoordinator();
  coordinator.reserve("speech-1");
  assert.throws(() => coordinator.beginPlayback("speech-2"), /pending identity mismatch/);
  coordinator.beginPlayback("speech-1");
  assert.throws(
    () => coordinator.observePlaybackEvent({ type: "ASSISTANT_AUDIO_CLEARED", responseId: "speech-2" }),
    /playback identity mismatch/,
  );
  coordinator.reset();
  assert.deepEqual(coordinator.snapshot(), { pendingResponseId: null, activeResponseId: null });
  assert.doesNotThrow(() => coordinator.assertProviderAudioAllowed());
});
