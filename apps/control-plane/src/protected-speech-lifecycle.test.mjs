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

test("failed response after playback starts waits for the buffer terminal event", () => {
  const lifecycle = new ProtectedSpeechLifecycle();
  lifecycle.begin("RECOVERY", "evt-4");
  lifecycle.bindResponse("resp-4");
  lifecycle.markPlaybackStarted("resp-4");

  assert.deepEqual(lifecycle.onResponseDone("resp-4", "failed"), { released: false });
  assert.equal(lifecycle.isActive(), true);
  assert.equal(lifecycle.onPlaybackCleared("resp-4").released, true);
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
