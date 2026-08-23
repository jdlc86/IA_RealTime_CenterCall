import test from "node:test";
import assert from "node:assert/strict";
import { AuthoritativeCallerInputOwner, TelnyxSampleCountVad } from "./caller-input.mjs";

function frame(sample, samples = 320) {
  const bytes = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) bytes.writeInt16BE(sample, index * 2);
  return bytes.toString("base64");
}

const voiced = frame(12_000);
const silence = frame(0);
const config = { startRms: 0.2, stopRms: 0.05, minSpeechMs: 40, minSilenceMs: 40 };

test("sample-count VAD uses media samples rather than arrival time", () => {
  const vad = new TelnyxSampleCountVad(config);
  assert.equal(vad.observe(voiced).boundary, null);
  const started = vad.observe(voiced);
  assert.equal(started.boundary.type, "SPEECH_START");
  assert.equal(started.boundary.replayPayloads.length, 2);
  assert.equal(vad.observe(silence).boundary, null);
  assert.equal(vad.observe(silence).boundary.type, "SPEECH_END");
  assert.equal(vad.snapshot().processedSamples, 1_280);
});

test("authoritative owner buffers exact onset and emits completed transcript only after STT", async () => {
  const requests = [];
  const owner = new AuthoritativeCallerInputOwner(async (request) => {
    requests.push(request);
    return { itemId: request.itemId, transcript: "  hola   mundo " };
  }, config);

  assert.deepEqual((await owner.observe(voiced)).events, []);
  const start = await owner.observe(voiced);
  assert.deepEqual(start.events, [{ type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: null }]);
  await owner.observe(voiced);
  await owner.observe(silence);
  const completed = await owner.observe(silence);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].itemId, "gemini-candidate-1");
  assert.equal(requests[0].payloads.length, 5);
  assert.deepEqual(completed.events, [
    { type: "CALLER_SPEECH_STOPPED", itemId: "gemini-candidate-1" },
    { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "hola mundo", playbackResponseIdAtStart: null },
  ]);
  assert.equal(owner.snapshot().transcriptReady, true);
});

test("playback identity is captured on first acoustic evidence, before speech threshold", async () => {
  const owner = new AuthoritativeCallerInputOwner(async (request) => ({ itemId: request.itemId, transcript: "interrumpo" }), config);
  await owner.observe(voiced, "gemini-response-original");
  const start = await owner.observe(voiced, null);
  assert.equal(start.events[0].playbackResponseIdAtStart, "gemini-response-original");
  await owner.observe(silence, null);
  const completed = await owner.observe(silence, null);
  assert.equal(completed.events[1].playbackResponseIdAtStart, "gemini-response-original");
  const released = owner.resolve("gemini-candidate-1", "INTERRUPT");
  assert.equal(released.playbackResponseIdAtStart, "gemini-response-original");
  assert.equal(released.mediaPayloads.length, 4);
});

test("STT identity mismatch fails closed and discards candidate", async () => {
  const owner = new AuthoritativeCallerInputOwner(async () => ({ itemId: "wrong", transcript: "texto" }), config);
  await owner.observe(voiced);
  await owner.observe(voiced);
  await owner.observe(silence);
  await assert.rejects(owner.observe(silence), /identity mismatch/);
  assert.equal(owner.snapshot().activeItemId, null);
});

test("candidate cannot be resolved before authoritative transcript completion", async () => {
  const owner = new AuthoritativeCallerInputOwner(async (request) => ({ itemId: request.itemId, transcript: "texto" }), config);
  await owner.observe(voiced);
  await owner.observe(voiced);
  assert.throws(() => owner.resolve("gemini-candidate-1", "NORMAL"), /no authoritative transcript/);
});
