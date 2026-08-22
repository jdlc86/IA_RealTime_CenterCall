import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtectedSpeechLifecycle } from "../.test-dist/protected-speech-lifecycle.js";

test("completed generation does not release protection before SIP playback stops", () => {
  const lifecycle = new ProtectedSpeechLifecycle();
  assert.equal(lifecycle.begin("GREETING", "evt-1"), true);
  assert.equal(lifecycle.bindResponse("resp-1"), true);
  assert.equal(lifecycle.markPlaybackStarted("resp-1"), true);

  assert.deepEqual(lifecycle.onResponseDone("resp-1", "completed"), { released: false });
  assert.equal(lifecycle.isActive(), true);

  const release = lifecycle.onPlaybackStopped("resp-1");
  assert.equal(release.released, true);
  assert.equal(release.kind, "GREETING");
  assert.equal(release.reason, "output_audio_buffer_stopped");
  assert.equal(lifecycle.isActive(), false);
});

test("events from another response cannot release protected speech", () => {
  const lifecycle = new ProtectedSpeechLifecycle();
  lifecycle.begin("RECOVERY", "evt-2");
  lifecycle.bindResponse("resp-protected");
  lifecycle.markPlaybackStarted("resp-protected");

  assert.deepEqual(lifecycle.onPlaybackStopped("resp-other"), { released: false });
  assert.equal(lifecycle.isActive(), true);
});

test("failed response before playback releases protection", () => {
  const lifecycle = new ProtectedSpeechLifecycle();
  lifecycle.begin("RECOVERY", "evt-3");
  lifecycle.bindResponse("resp-3");

  const release = lifecycle.onResponseDone("resp-3", "failed");
  assert.equal(release.released, true);
  assert.equal(release.kind, "RECOVERY");
  assert.equal(release.reason, "response_done_failed");
});

test("failed response after playback starts replays when the buffer is cleared", () => {
  const lifecycle = new ProtectedSpeechLifecycle();
  lifecycle.begin("RECOVERY", "evt-4");
  lifecycle.bindResponse("resp-4");
  lifecycle.markPlaybackStarted("resp-4");

  assert.deepEqual(lifecycle.onResponseDone("resp-4", "failed"), { released: false });
  assert.equal(lifecycle.isActive(), true);
  assert.deepEqual(lifecycle.onPlaybackCleared("resp-4"), {
    released: false,
    replayRequested: true,
    kind: "RECOVERY",
    reason: "output_audio_buffer_cleared",
  });
  assert.equal(lifecycle.isActive(), true);
});

test("cleared greeting waits for response completion and then requests a replay", () => {
  const lifecycle = new ProtectedSpeechLifecycle();
  lifecycle.begin("GREETING", "evt-clear-1");
  lifecycle.bindResponse("resp-clear-1");
  lifecycle.markPlaybackStarted("resp-clear-1");

  assert.deepEqual(lifecycle.onPlaybackCleared("resp-clear-1"), { released: false });
  assert.equal(lifecycle.snapshot()?.replayPending, true);
  assert.equal(lifecycle.isActive(), true);

  assert.deepEqual(lifecycle.onResponseDone("resp-clear-1", "completed"), {
    released: false,
    replayRequested: true,
    kind: "GREETING",
    reason: "output_audio_buffer_cleared",
  });
  assert.equal(lifecycle.prepareReplay("evt-clear-2"), true);
  assert.deepEqual(lifecycle.snapshot(), {
    kind: "GREETING",
    clientEventId: "evt-clear-2",
    responseId: null,
    playbackStarted: false,
    responseCompleted: false,
    replayPending: false,
    replayCount: 1,
  });

  lifecycle.bindResponse("resp-clear-2");
  lifecycle.markPlaybackStarted("resp-clear-2");
  const release = lifecycle.onPlaybackStopped("resp-clear-2");
  assert.equal(release.released, true);
  assert.equal(release.reason, "output_audio_buffer_stopped");
});

test("cleared playback after response completion requests replay immediately", () => {
  const lifecycle = new ProtectedSpeechLifecycle();
  lifecycle.begin("GREETING", "evt-done-first");
  lifecycle.bindResponse("resp-done-first");
  lifecycle.markPlaybackStarted("resp-done-first");

  assert.deepEqual(lifecycle.onResponseDone("resp-done-first", "completed"), { released: false });
  assert.equal(lifecycle.onPlaybackCleared("resp-done-first").replayRequested, true);
  assert.equal(lifecycle.isActive(), true);
});

test("protected replay is bounded and releases only after exhaustion", () => {
  const lifecycle = new ProtectedSpeechLifecycle(1);
  lifecycle.begin("GREETING", "evt-bounded-1");
  lifecycle.bindResponse("resp-bounded-1");
  lifecycle.markPlaybackStarted("resp-bounded-1");
  lifecycle.onResponseDone("resp-bounded-1", "completed");
  assert.equal(lifecycle.onPlaybackCleared("resp-bounded-1").replayRequested, true);
  assert.equal(lifecycle.prepareReplay("evt-bounded-2"), true);

  lifecycle.bindResponse("resp-bounded-2");
  lifecycle.markPlaybackStarted("resp-bounded-2");
  lifecycle.onResponseDone("resp-bounded-2", "completed");
  const exhausted = lifecycle.onPlaybackCleared("resp-bounded-2");
  assert.equal(exhausted.released, true);
  assert.equal(exhausted.reason, "output_audio_buffer_cleared_replay_exhausted");
  assert.equal(lifecycle.isActive(), false);
});

test("matching response.create error releases when playback never started", () => {
  const lifecycle = new ProtectedSpeechLifecycle();
  lifecycle.begin("GREETING", "evt-5");

  assert.deepEqual(lifecycle.onClientError("unrelated"), { released: false });
  const release = lifecycle.onClientError("evt-5");
  assert.equal(release.released, true);
  assert.equal(release.reason, "response_create_error");
});

test("nested protected speech is rejected", () => {
  const lifecycle = new ProtectedSpeechLifecycle();
  assert.equal(lifecycle.begin("GREETING", "evt-6"), true);
  assert.equal(lifecycle.begin("RECOVERY", "evt-7"), false);
});
