import test from "node:test";
import assert from "node:assert/strict";
import {
  decideTurnConcurrencyAcquire,
  shouldClearInputOnTurnConcurrencyRelease,
  shouldRestoreInputDetectionOnTurnConcurrencyRelease,
} from "../.test-dist/turn-concurrency-acquire-policy.js";

test("usable transcript before playback acquires semantic serialization", () => {
  assert.equal(decideTurnConcurrencyAcquire({
    usableTranscript: true,
    normalPlaybackActive: false,
    higherLayerOwns: false,
    newerCallerSpeechObserved: false,
  }), "ACQUIRE");
});

test("older split fragment cannot acquire v36 after a newer caller item started", () => {
  assert.equal(decideTurnConcurrencyAcquire({
    usableTranscript: true,
    normalPlaybackActive: false,
    higherLayerOwns: false,
    newerCallerSpeechObserved: true,
  }), "BYPASS_NEWER_CALLER_SPEECH");
});

test("late transcript after normal playback started cannot reacquire v36 lock", () => {
  assert.equal(decideTurnConcurrencyAcquire({
    usableTranscript: true,
    normalPlaybackActive: true,
    higherLayerOwns: false,
    newerCallerSpeechObserved: false,
  }), "BYPASS_PLAYBACK_ALREADY_STARTED");
});

test("unusable transcript never acquires ownership", () => {
  assert.equal(decideTurnConcurrencyAcquire({
    usableTranscript: false,
    normalPlaybackActive: false,
    higherLayerOwns: false,
    newerCallerSpeechObserved: false,
  }), "BYPASS_UNUSABLE");
});

test("higher-layer ownership always wins over v36", () => {
  assert.equal(decideTurnConcurrencyAcquire({
    usableTranscript: true,
    normalPlaybackActive: false,
    higherLayerOwns: true,
    newerCallerSpeechObserved: true,
  }), "BYPASS_HIGHER_LAYER");
});

test("normal playback release preserves immediately arriving barge-in audio", () => {
  assert.equal(shouldClearInputOnTurnConcurrencyRelease("normal_assistant_playback_started"), false);
});

test("normal playback release delegates input detection to v40 barge-in owner", () => {
  assert.equal(shouldRestoreInputDetectionOnTurnConcurrencyRelease("normal_assistant_playback_started"), false);
});

test("recovery releases may still discard stale buffered audio and restore tenant VAD", () => {
  assert.equal(shouldClearInputOnTurnConcurrencyRelease("protected_playback_completed"), true);
  assert.equal(shouldClearInputOnTurnConcurrencyRelease("watchdog"), true);
  assert.equal(shouldRestoreInputDetectionOnTurnConcurrencyRelease("protected_playback_completed"), true);
  assert.equal(shouldRestoreInputDetectionOnTurnConcurrencyRelease("watchdog"), true);
});
