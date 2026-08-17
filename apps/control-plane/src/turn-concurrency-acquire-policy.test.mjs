import test from "node:test";
import assert from "node:assert/strict";
import { decideTurnConcurrencyAcquire } from "../.test-dist/turn-concurrency-acquire-policy.js";

test("usable transcript before playback acquires semantic serialization", () => {
  assert.equal(decideTurnConcurrencyAcquire({
    usableTranscript: true,
    normalPlaybackActive: false,
    higherLayerOwns: false,
  }), "ACQUIRE");
});

test("late transcript after normal playback started cannot reacquire v36 lock", () => {
  assert.equal(decideTurnConcurrencyAcquire({
    usableTranscript: true,
    normalPlaybackActive: true,
    higherLayerOwns: false,
  }), "BYPASS_PLAYBACK_ALREADY_STARTED");
});

test("unusable transcript never acquires ownership", () => {
  assert.equal(decideTurnConcurrencyAcquire({
    usableTranscript: false,
    normalPlaybackActive: false,
    higherLayerOwns: false,
  }), "BYPASS_UNUSABLE");
});

test("higher-layer ownership always wins over v36", () => {
  assert.equal(decideTurnConcurrencyAcquire({
    usableTranscript: true,
    normalPlaybackActive: false,
    higherLayerOwns: true,
  }), "BYPASS_HIGHER_LAYER");
});
