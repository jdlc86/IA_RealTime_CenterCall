import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import {
  FastPcm24To16Resampler,
  geminiAudioToTelnyxMedia,
  telnyxClearPlaybackMessage,
  telnyxInboundMediaToGemini,
} from "./fast-audio-bridge.mjs";

function pcmSine(sampleRate, samples, frequency = 440) {
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12_000);
    out.writeInt16LE(value, i * 2);
  }
  return out;
}

test("caller Telnyx L16 payload is forwarded to Gemini byte-identically", () => {
  const raw = pcmSine(16_000, 320);
  const payload = raw.toString("base64");
  const bridged = telnyxInboundMediaToGemini({
    event: "media",
    media: { track: "inbound", chunk: "17", payload },
  });
  assert.equal(bridged.chunk, 17);
  assert.equal(bridged.payload, payload);
  assert.equal(bridged.geminiMessage.realtimeInput.audio.data, payload);
  assert.equal(bridged.geminiMessage.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(Buffer.compare(Buffer.from(bridged.geminiMessage.realtimeInput.audio.data, "base64"), raw), 0);
});

test("outbound Gemini 24 kHz PCM is converted once to Telnyx 16 kHz PCM", () => {
  const resampler = new FastPcm24To16Resampler();
  const source = pcmSine(24_000, 480);
  const message = geminiAudioToTelnyxMedia({
    mimeType: "audio/pcm;rate=24000",
    data: source.toString("base64"),
  }, resampler);
  assert.equal(message.event, "media");
  const output = Buffer.from(message.media.payload, "base64");
  assert.equal(output.length % 2, 0);
  const samples = output.length / 2;
  assert.ok(samples >= 318 && samples <= 322, `expected about 320 output samples, got ${samples}`);
});

test("resampler stays continuous across Gemini chunk boundaries", () => {
  const whole = pcmSine(24_000, 960);
  const once = new FastPcm24To16Resampler().push(whole);
  const splitResampler = new FastPcm24To16Resampler();
  const a = splitResampler.push(whole.subarray(0, 480 * 2));
  const b = splitResampler.push(whole.subarray(480 * 2));
  const split = Buffer.concat([a, b]);
  assert.ok(Math.abs(once.length - split.length) <= 2);
});

test("barge-in clear is a single Telnyx protocol message", () => {
  assert.deepEqual(telnyxClearPlaybackMessage(), { event: "clear" });
});

test("local caller fast-path overhead stays far below realtime budget", () => {
  const payload = pcmSine(16_000, 320).toString("base64");
  const message = { event: "media", media: { track: "inbound", chunk: 1, payload } };
  const iterations = 10_000;
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    message.media.chunk = i + 1;
    telnyxInboundMediaToGemini(message);
  }
  const elapsedMs = performance.now() - started;
  const averageMs = elapsedMs / iterations;
  assert.ok(averageMs < 0.1, `caller fast-path average ${averageMs.toFixed(4)}ms exceeds 0.1ms`);
});
