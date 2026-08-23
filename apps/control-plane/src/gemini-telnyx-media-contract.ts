export const GEMINI_INPUT_AUDIO_MIME = "audio/pcm;rate=16000" as const;
export const GEMINI_OUTPUT_SAMPLE_RATE = 24_000 as const;
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

/**
 * RTP L16 is network byte order (big-endian); Gemini Live PCM16 is little-endian.
 * The sample rate and sample values are unchanged, so this is an endian transform,
 * not a resampler or transcoder.
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
    stream_bidirectional_sampling_rate: GEMINI_OUTPUT_SAMPLE_RATE,
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

export function geminiPcmPayloadToTelnyxMedia(payloadBase64: string): Readonly<Record<string, unknown>> {
  const networkOrder = swapPcm16Endianness(decodeBase64(payloadBase64));
  return Object.freeze({
    event: "media",
    media: { payload: encodeBase64(networkOrder) },
  });
}
