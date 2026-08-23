import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeminiTelnyxStreamingStart,
  geminiPcm24kPayloadToTelnyxMedia,
  swapPcm16Endianness,
  telnyxL16PayloadToGeminiRealtimeInput,
} from "../.test-dist/gemini-telnyx-media-contract.js";
import { Pcm16LinearResampler24To16 } from "../.test-dist/pcm16-stream-resampler.js";

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function bytes(value) {
  return [...Buffer.from(value, "base64")];
}

function pcm16le(values) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer.toString("base64");
}

function pcm16beFromMedia(message) {
  const payload = Buffer.from(message.media.payload, "base64");
  const values = [];
  for (let offset = 0; offset < payload.length; offset += 2) values.push(payload.readInt16BE(offset));
  return values;
}

test("PCM16 endian conversion is deterministic and reversible", () => {
  const source = Uint8Array.from([0x12, 0x34, 0xab, 0xcd]);
  const swapped = swapPcm16Endianness(source);
  assert.deepEqual([...swapped], [0x34, 0x12, 0xcd, 0xab]);
  assert.deepEqual([...swapPcm16Endianness(swapped)], [...source]);
  assert.throws(() => swapPcm16Endianness(Uint8Array.of(0x01)), /complete 16-bit samples/);
});

test("Telnyx L16 input becomes Gemini PCM16 little-endian at 16 kHz", () => {
  const message = telnyxL16PayloadToGeminiRealtimeInput(b64([0x12, 0x34, 0xab, 0xcd]));
  assert.equal(message.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.deepEqual(bytes(message.realtimeInput.audio.data), [0x34, 0x12, 0xcd, 0xab]);
});

test("Gemini 24 kHz PCM output is statefully resampled before Telnyx L16 framing", () => {
  const resampler = new Pcm16LinearResampler24To16();
  const first = geminiPcm24kPayloadToTelnyxMedia(pcm16le([0, 3000]), resampler);
  const second = geminiPcm24kPayloadToTelnyxMedia(pcm16le([6000, 9000]), resampler);

  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(pcm16beFromMedia(first), [0]);
  assert.deepEqual(pcm16beFromMedia(second), [4500]);
});

test("resampler continuity is independent of provider chunk boundaries", () => {
  const oneChunk = new Pcm16LinearResampler24To16();
  const splitChunks = new Pcm16LinearResampler24To16();
  const samples = Int16Array.from([0, 1000, 2000, 3000, 4000, 5000, 6000]);
  const expected = [...oneChunk.push(samples)];
  const actual = [
    ...splitChunks.push(Int16Array.from(samples.slice(0, 2))),
    ...splitChunks.push(Int16Array.from(samples.slice(2, 5))),
    ...splitChunks.push(Int16Array.from(samples.slice(5))),
  ];
  assert.deepEqual(actual, expected);
});

test("Telnyx streaming contract pins documented L16 at 16 kHz", () => {
  assert.deepEqual(buildGeminiTelnyxStreamingStart("wss://example.invalid/gemini-media"), {
    stream_url: "wss://example.invalid/gemini-media",
    stream_track: "inbound_track",
    stream_codec: "L16",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "L16",
    stream_bidirectional_sampling_rate: 16000,
  });
  assert.throws(() => buildGeminiTelnyxStreamingStart("https://example.invalid"), /requires a wss:\/\//);
});
