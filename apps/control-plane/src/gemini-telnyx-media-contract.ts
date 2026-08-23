import type { Pcm16Resampler } from "./pcm16-stream-resampler.js";

export const GEMINI_INPUT_AUDIO_MIME = "audio/pcm;rate=16000" as const;
export const GEMINI_OUTPUT_SAMPLE_RATE = 24_000 as const;
export const TELNYX_GEMINI_STREAM_SAMPLE_RATE = 16_000 as const;
export const TELNYX_GEMINI_STREAM_CODEC = "L16" as const;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function littleEndianBytesToPcm16(bytes: Uint8Array): Int16Array {
  if (bytes.byteLength % 2 !== 0) throw new Error("PCM16 payload must contain complete 16-bit samples");
  const samples = new Int16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

function pcm16ToLittleEndianBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(i * 2, samples[i], true);
  return bytes;
}

/**
 * RTP L16 is network byte order (big-endian); Gemini Live PCM16 is little-endian.
 * This transform changes only byte order and never sample timing.
 */
export function swapPcm16Endianness(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength % 2 !== 0) throw new Error("PCM16 payload must contain complete 16-bit samples");
  const output = new Uint8Array(bytes.byteLength);
  for (let i = 0; i < bytes.byteLength; i += 2) {
    output[i] = bytes[i + 1];
    output[i + 1] = bytes[i];
  }
  return output;
}

export function buildGeminiTelnyxStreamingStart(streamUrl: string): Readonly<Record<string, unknown>> {
  const normalized = streamUrl.trim();
  if (!normalized.startsWith("wss://")) throw new Error("Gemini media stream requires a wss:// URL");
  return Object.freeze({
    stream_url: normalized,
    stream_track: "inbound_track",
    stream_codec: TELNYX_GEMINI_STREAM_CODEC,
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: TELNYX_GEMINI_STREAM_CODEC,
    stream_bidirectional_sampling_rate: TELNYX_GEMINI_STREAM_SAMPLE_RATE,
  });
}

export function telnyxL16PayloadToGeminiRealtimeInput(payloadBase64: string): Readonly<Record<string, unknown>> {
  const littleEndian = swapPcm16Endianness(decodeBase64(payloadBase64));
  return Object.freeze({
    realtimeInput: {
      audio: {
        data: encodeBase64(littleEndian),
        mimeType: GEMINI_INPUT_AUDIO_MIME,
      },
    },
  });
}

/**
 * Gemini output is PCM16 little-endian at 24 kHz. Telnyx L16 is 16 kHz network
 * byte order, so provider output must pass through one session-owned resampler
 * before endian conversion. The resampler is injected to keep state ownership out
 * of this stateless framing module.
 */
export function geminiPcm24kPayloadToTelnyxMedia(
  payloadBase64: string,
  resampler: Pcm16Resampler,
): Readonly<Record<string, unknown>> | null {
  const source = littleEndianBytesToPcm16(decodeBase64(payloadBase64));
  const resampled = resampler.push(source);
  if (resampled.length === 0) return null;
  const networkOrder = swapPcm16Endianness(pcm16ToLittleEndianBytes(resampled));
  return Object.freeze({
    event: "media",
    media: { payload: encodeBase64(networkOrder) },
  });
}
