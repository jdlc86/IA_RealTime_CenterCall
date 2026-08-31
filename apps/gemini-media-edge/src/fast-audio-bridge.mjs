import { buildFastRealtimeAudio } from "./fast-gemini31.mjs";

function required(value, field, max = 2_000_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} exceeds configured limit`);
  return normalized;
}

export function telnyxInboundMediaToGemini(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.event !== "media") {
    throw new Error("Fast audio bridge requires a Telnyx media event");
  }
  if (message.media?.track !== "inbound") return null;
  const chunk = Number(message.media.chunk);
  if (!Number.isSafeInteger(chunk) || chunk < 1) throw new Error("Telnyx media chunk is invalid");
  const payload = required(message.media.payload, "Telnyx media payload");
  return Object.freeze({
    chunk,
    payload,
    geminiMessage: buildFastRealtimeAudio(payload, 16_000),
  });
}

/**
 * Stateful linear 24 kHz → 16 kHz PCM16 little-endian resampler.
 * It exists only on the model→Telnyx leg. Caller audio is already verified as
 * mono L16/16 kHz by the admission credential boundary and is forwarded as-is.
 */
export class FastPcm24To16Resampler {
  constructor() {
    this.pending = null;
    this.phase = 0;
  }

  reset() {
    this.pending = null;
    this.phase = 0;
  }

  push(bytes) {
    const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    if (input.length === 0) return Buffer.alloc(0);
    if (input.length % 2 !== 0) throw new Error("Gemini PCM16 output must contain complete samples");

    const currentSamples = input.length / 2;
    const sourceSamples = currentSamples + (this.pending === null ? 0 : 1);
    if (sourceSamples < 2) {
      this.pending = input.readInt16LE(0);
      return Buffer.alloc(0);
    }

    const sampleAt = (index) => {
      if (this.pending !== null) {
        if (index === 0) return this.pending;
        return input.readInt16LE((index - 1) * 2);
      }
      return input.readInt16LE(index * 2);
    };

    const outputCapacity = Math.ceil((sourceSamples + 2) * 2 / 3);
    const output = Buffer.allocUnsafe(outputCapacity * 2);
    let outputSamples = 0;
    let position = this.phase;
    while (position + 1 < sourceSamples) {
      const left = Math.floor(position);
      const fraction = position - left;
      const a = sampleAt(left);
      const b = sampleAt(left + 1);
      const interpolated = Math.round(a + ((b - a) * fraction));
      output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), outputSamples * 2);
      outputSamples += 1;
      position += 1.5;
    }

    const consumed = Math.floor(position);
    this.phase = position - consumed;
    this.pending = sampleAt(sourceSamples - 1);
    return output.subarray(0, outputSamples * 2);
  }
}

export function geminiAudioToTelnyxMedia(audioPart, resampler) {
  if (!audioPart || typeof audioPart !== "object" || Array.isArray(audioPart)) throw new Error("Gemini audio part is invalid");
  const mimeType = required(audioPart.mimeType, "Gemini audio MIME type", 128);
  if (!/^audio\/pcm(?:;.*rate=24000|;|$)/i.test(mimeType)) throw new Error("Gemini fast path requires PCM audio output");
  const encoded = required(audioPart.data, "Gemini audio data");
  const pcm24 = Buffer.from(encoded, "base64");
  if (!pcm24.length || pcm24.length % 2 !== 0) throw new Error("Gemini audio payload is invalid PCM16");
  if (!resampler || typeof resampler.push !== "function") throw new Error("Gemini fast path resampler is required");
  const pcm16 = resampler.push(pcm24);
  if (!pcm16.length) return null;
  return Object.freeze({
    event: "media",
    media: Object.freeze({ payload: pcm16.toString("base64") }),
  });
}

export function telnyxClearPlaybackMessage() {
  return Object.freeze({ event: "clear" });
}
