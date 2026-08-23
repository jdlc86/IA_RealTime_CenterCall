import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { GeminiTelnyxAcousticVad } from "../.test-dist/gemini-telnyx-acoustic-vad.js";

const source = readFileSync(new URL("./gemini-telnyx-acoustic-vad.ts", import.meta.url), "utf8");

function pcm16be(sample, count) {
  const buffer = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) buffer.writeInt16BE(sample, index * 2);
  return buffer.toString("base64");
}

function vad(overrides = {}) {
  return new GeminiTelnyxAcousticVad({
    startRms: 0.10,
    stopRms: 0.04,
    minSpeechMs: 20,
    minSilenceMs: 30,
    ...overrides,
  });
}

test("speech start is proven by accumulated samples and replays the onset payloads", () => {
  const owner = vad();
  const loudA = pcm16be(8000, 160); // 10 ms at 16 kHz
  const loudB = pcm16be(9000, 160);

  const first = owner.observe(loudA);
  assert.equal(first.boundary, null);
  assert.equal(first.shouldBufferPayload, false);
  assert.equal(first.snapshot.state, "SILENCE");
  assert.equal(first.snapshot.candidateSpeechSamples, 160);

  const second = owner.observe(loudB);
  assert.deepEqual(second.boundary, {
    type: "SPEECH_START",
    replayPayloads: [loudA, loudB],
  });
  assert.equal(second.shouldBufferPayload, false, "onset payloads are replayed exactly once by the boundary");
  assert.equal(second.snapshot.state, "SPEECH");
  assert.equal(second.snapshot.candidateSpeechSamples, 0);
});

test("speech end is proven by silence sample count without timers", () => {
  const owner = vad();
  owner.observe(pcm16be(9000, 320));

  const quietA = owner.observe(pcm16be(0, 160));
  assert.equal(quietA.boundary, null);
  assert.equal(quietA.shouldBufferPayload, true);
  assert.equal(quietA.snapshot.candidateSilenceSamples, 160);

  const quietB = owner.observe(pcm16be(0, 320));
  assert.deepEqual(quietB.boundary, { type: "SPEECH_END" });
  assert.equal(quietB.shouldBufferPayload, true);
  assert.equal(quietB.snapshot.state, "SILENCE");
  assert.equal(quietB.snapshot.candidateSilenceSamples, 0);
});

test("hysteresis prevents mid-level audio from ending active speech", () => {
  const owner = vad();
  owner.observe(pcm16be(9000, 320));
  const mid = owner.observe(pcm16be(2500, 640));
  assert.equal(mid.rms > 0.04, true);
  assert.equal(mid.rms < 0.10, true);
  assert.equal(mid.boundary, null);
  assert.equal(mid.snapshot.state, "SPEECH");
  assert.equal(mid.snapshot.candidateSilenceSamples, 0);
});

test("sub-threshold onset resets instead of accumulating stale speech evidence", () => {
  const owner = vad();
  owner.observe(pcm16be(9000, 160));
  const reset = owner.observe(pcm16be(0, 160));
  assert.equal(reset.snapshot.candidateSpeechSamples, 0);
  assert.equal(reset.snapshot.state, "SILENCE");

  const next = owner.observe(pcm16be(9000, 160));
  assert.equal(next.boundary, null, "previous onset evidence must not survive intervening silence");
});

test("sample accounting is independent of transport chunk boundaries", () => {
  const a = vad();
  const b = vad();
  a.observe(pcm16be(9000, 320));
  b.observe(pcm16be(9000, 80));
  b.observe(pcm16be(9000, 80));
  b.observe(pcm16be(9000, 160));
  assert.equal(a.snapshot().state, "SPEECH");
  assert.equal(b.snapshot().state, "SPEECH");
  assert.equal(a.snapshot().processedSamples, 320);
  assert.equal(b.snapshot().processedSamples, 320);
});

test("invalid configuration and malformed PCM fail closed", () => {
  assert.throws(() => vad({ startRms: 0 }), /startRms/);
  assert.throws(() => vad({ stopRms: 0.2 }), /stopRms/);
  assert.throws(() => vad({ minSpeechMs: 0 }), /minSpeechMs/);
  const owner = vad();
  assert.throws(() => owner.observe("not base64 ***"), /invalid base64/);
  assert.throws(() => owner.observe(Buffer.from([0x01]).toString("base64")), /complete PCM16_BE samples/);
});

test("VAD owner contains no wall-clock heuristic or provider wire operation", () => {
  assert.doesNotMatch(source, /setTimeout\s*\(|setInterval\s*\(|Date\.now\s*\(|\bsleep\s*\(/);
  assert.doesNotMatch(source, /\.send\s*\(|realtimeInput|clientContent|response\.create/);
});
