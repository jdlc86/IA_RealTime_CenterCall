import test from "node:test";
import assert from "node:assert/strict";
import { AuthoritativeCallerInputOwner, TelnyxSampleCountVad } from "./caller-input.mjs";

function frame(sample, samples = 320) {
  const bytes = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) bytes.writeInt16LE(sample, index * 2);
  return bytes.toString("base64");
}

const voiced = frame(12_000);
const silence = frame(0);
const config = { startRms: 0.2, stopRms: 0.05, minSpeechMs: 40, minSilenceMs: 40 };

test("sample-count VAD decodes verified Telnyx WebSocket L16 little-endian and uses media samples", () => {
  const vad = new TelnyxSampleCountVad(config);
  assert.equal(vad.observe(voiced).boundary, null);
  const started = vad.observe(voiced);
  assert.equal(started.boundary.type, "SPEECH_START");
  assert.equal(started.boundary.replayPayloads.length, 2);
  assert.equal(vad.observe(silence).boundary, null);
  assert.equal(vad.observe(silence).boundary.type, "SPEECH_END");
  assert.equal(vad.snapshot().processedSamples, 1_280);
});

test("production VAD threshold accepts moderate telephone speech levels", () => {
  const vad = new TelnyxSampleCountVad({ startRms: 0.04, stopRms: 0.015, minSpeechMs: 40, minSilenceMs: 160 });
  const moderateSpeech = frame(1_800);
  assert.equal(vad.observe(moderateSpeech).boundary, null);
  const started = vad.observe(moderateSpeech);
  assert.equal(started.boundary.type, "SPEECH_START");
  assert.ok(started.rms > 0.04);
  for (let index = 0; index < 7; index += 1) assert.equal(vad.observe(silence).boundary, null);
  assert.equal(vad.observe(silence).boundary.type, "SPEECH_END");
});

test("authoritative owner buffers exact PCM16 little-endian and emits completed transcript only after STT", async () => {
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
  const firstBuffered = Buffer.from(requests[0].payloads[0], "base64");
  assert.equal(firstBuffered.readInt16LE(0), 12_000);
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
  assert.equal(Buffer.from(released.mediaPayloads[0], "base64").readInt16LE(0), 12_000);
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

test("sample-count VAD learns elevated line noise and still closes the caller turn", () => {
  const vad = new TelnyxSampleCountVad(config);
  const elevatedNoise = frame(3_300);
  for (let index = 0; index < 20; index += 1) assert.equal(vad.observe(elevatedNoise).boundary, null);
  assert.ok(vad.snapshot().noiseFloorRms > config.stopRms);
  assert.ok(vad.snapshot().effectiveStopRms > config.stopRms);
  assert.ok(vad.snapshot().effectiveStopRms < config.startRms);
  assert.equal(vad.observe(voiced).boundary, null);
  assert.equal(vad.observe(voiced).boundary.type, "SPEECH_START");
  assert.equal(vad.observe(elevatedNoise).boundary, null);
  assert.equal(vad.observe(elevatedNoise).boundary.type, "SPEECH_END");
});

test("product-owned input suspension drops caller media and restore starts a fresh candidate", async () => {
  let transcriptions = 0;
  const owner = new AuthoritativeCallerInputOwner(async (request) => {
    transcriptions += 1;
    return { itemId: request.itemId, transcript: "hola" };
  }, config);

  owner.suspend();
  assert.equal(owner.snapshot().inputDetectionEnabled, false);
  assert.deepEqual((await owner.observe(voiced)).events, []);
  assert.deepEqual((await owner.observe(voiced)).events, []);
  assert.equal(owner.snapshot().activeItemId, null);
  assert.equal(transcriptions, 0);

  owner.restore();
  assert.equal(owner.snapshot().inputDetectionEnabled, true);
  await owner.observe(voiced);
  const started = await owner.observe(voiced);
  assert.equal(started.events[0].itemId, "gemini-candidate-1");
});

test("caller input clear invalidates an active candidate without reusing its identity", async () => {
  const owner = new AuthoritativeCallerInputOwner(async (request) => ({ itemId: request.itemId, transcript: "hola" }), config);
  await owner.observe(voiced);
  await owner.observe(voiced);
  assert.equal(owner.snapshot().activeItemId, "gemini-candidate-1");
  owner.clear();
  assert.equal(owner.snapshot().activeItemId, null);
  await owner.observe(voiced);
  const next = await owner.observe(voiced);
  assert.equal(next.events[0].itemId, "gemini-candidate-2");
});
