import assert from "node:assert/strict";
import test from "node:test";
import { TelnyxGeminiMediaStreamOwner } from "../.test-dist/telnyx-gemini-media-stream-owner.js";

function start(owner, streamId = "stream-1") {
  return owner.observe(JSON.stringify({
    event: "start",
    stream_id: streamId,
    start: { media_format: { encoding: "L16", sample_rate: 16000, channels: 1 } },
  }));
}

function media(chunk, payload = `audio-${chunk}`, streamId = "stream-1") {
  return JSON.stringify({
    event: "media",
    stream_id: streamId,
    media: { track: "inbound", chunk: String(chunk), payload },
  });
}

test("Telnyx Gemini media start validates one immutable mono L16 16k stream", () => {
  const owner = new TelnyxGeminiMediaStreamOwner();
  assert.equal(start(owner).snapshot.state, "READY");
  assert.equal(owner.snapshot().streamId, "stream-1");
  assert.throws(() => start(owner), /one-shot/);

  const wrong = new TelnyxGeminiMediaStreamOwner();
  assert.throws(() => wrong.observe(JSON.stringify({
    event: "start",
    stream_id: "bad",
    start: { media_format: { encoding: "L16", sample_rate: 24000, channels: 1 } },
  })), /mono L16 at 16000 Hz/);
  assert.equal(wrong.snapshot().state, "FAILED");
});

test("out-of-order Telnyx chunks are released only in chunk identity order", () => {
  const owner = new TelnyxGeminiMediaStreamOwner();
  start(owner);

  assert.deepEqual(owner.observe(media(2)).mediaPayloads, []);
  assert.deepEqual(owner.observe(media(1)).mediaPayloads, ["audio-1", "audio-2"]);
  assert.deepEqual(owner.observe(media(4)).mediaPayloads, []);
  assert.deepEqual(owner.observe(media(3)).mediaPayloads, ["audio-3", "audio-4"]);
  assert.equal(owner.snapshot().nextChunk, 5);
});

test("duplicate and stale chunks never replay caller audio", () => {
  const owner = new TelnyxGeminiMediaStreamOwner();
  start(owner);
  assert.deepEqual(owner.observe(media(1)).mediaPayloads, ["audio-1"]);
  assert.deepEqual(owner.observe(media(1, "duplicate")).mediaPayloads, []);
  assert.equal(owner.snapshot().nextChunk, 2);
});

test("missing chunk fails closed when bounded reorder window is exhausted", () => {
  const owner = new TelnyxGeminiMediaStreamOwner(2);
  start(owner);
  owner.observe(media(2));
  owner.observe(media(3));
  assert.throws(() => owner.observe(media(4)), /reorder window exceeded while waiting for chunk 1/);
  assert.equal(owner.snapshot().state, "FAILED");
});

test("stream identity cannot switch during one call", () => {
  const owner = new TelnyxGeminiMediaStreamOwner();
  start(owner, "stream-a");
  assert.throws(() => owner.observe(media(1, "audio", "stream-b")), /stream identity changed/);
  assert.equal(owner.snapshot().state, "FAILED");
});

test("marks and stop are structural evidence and never require a timer", () => {
  const owner = new TelnyxGeminiMediaStreamOwner();
  start(owner);
  assert.deepEqual(owner.observe(JSON.stringify({
    event: "mark", stream_id: "stream-1", mark: { name: "response-7" },
  })).returnedMarks, ["response-7"]);
  const stopped = owner.observe(JSON.stringify({ event: "stop", stream_id: "stream-1" }));
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.snapshot.state, "STOPPED");
  assert.throws(() => owner.observe(media(1)), /owner is stopped/);
});
