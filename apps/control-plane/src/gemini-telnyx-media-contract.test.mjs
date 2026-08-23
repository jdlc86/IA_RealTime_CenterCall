import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeminiTelnyxStreamingStart,
  geminiPcmPayloadToTelnyxMedia,
  swapPcm16Endianness,
  telnyxL16PayloadToGeminiRealtimeInput,
} from "../.test-dist/gemini-telnyx-media-contract.js";

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function bytes(value) {
  return [...Buffer.from(value, "base64")];
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

test("Gemini 24 kHz PCM output becomes Telnyx RTP L16 network order", () => {
  const message = geminiPcmPayloadToTelnyxMedia(b64([0x34, 0x12, 0xcd, 0xab]));
  assert.deepEqual(message, {
    event: "media",
    media: { payload: b64([0x12, 0x34, 0xab, 0xcd]) },
  });
});

test("Telnyx streaming contract uses isolated bidirectional L16 without provider fallback", () => {
  assert.deepEqual(buildGeminiTelnyxStreamingStart("wss://example.invalid/gemini-media"), {
    stream_url: "wss://example.invalid/gemini-media",
    stream_track: "inbound_track",
    stream_codec: "L16",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "L16",
    stream_bidirectional_sampling_rate: 24000,
  });
  assert.throws(() => buildGeminiTelnyxStreamingStart("https://example.invalid"), /requires a wss:\/\//);
});
