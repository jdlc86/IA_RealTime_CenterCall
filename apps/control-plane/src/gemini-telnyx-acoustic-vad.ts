export type GeminiTelnyxAcousticVadConfig = Readonly<{
  startRms: number;
  stopRms: number;
  minSpeechMs: number;
  minSilenceMs: number;
}>;

export type GeminiTelnyxAcousticVadBoundary =
  | Readonly<{ type: "SPEECH_START"; replayPayloads: readonly string[] }>
  | Readonly<{ type: "SPEECH_END" }>;

export type GeminiTelnyxAcousticVadSnapshot = Readonly<{
  state: "SILENCE" | "SPEECH";
  candidateSpeechSamples: number;
  candidateSilenceSamples: number;
  processedSamples: number;
}>;

export type GeminiTelnyxAcousticVadObservation = Readonly<{
  boundary: GeminiTelnyxAcousticVadBoundary | null;
  rms: number;
  shouldBufferPayload: boolean;
  snapshot: GeminiTelnyxAcousticVadSnapshot;
}>;

const SAMPLE_RATE_HZ = 16_000;

function decodeBase64(value: string): Uint8Array {
  const normalized = value.trim();
  if (!normalized) throw new Error("Gemini Telnyx acoustic VAD requires media payload");
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new Error("Gemini Telnyx acoustic VAD received invalid base64 media");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw new Error("Gemini Telnyx acoustic VAD requires complete PCM16_BE samples");
  }
  return bytes;
}

function pcm16BeRms(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = bytes.byteLength / 2;
  let sumSquares = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample = view.getInt16(index * 2, false) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

function msToSamples(milliseconds: number): number {
  return Math.ceil((milliseconds * SAMPLE_RATE_HZ) / 1000);
}

/**
 * Provider-edge acoustic VAD for Telnyx mono PCM16_BE at 16 kHz.
 *
 * Decisions are based only on decoded sample energy and accumulated sample counts.
 * There are no wall-clock timers, sleeps or arrival-time windows. The owner keeps
 * the onset payloads until speech is proven so the caller audio that established
 * the boundary can be replayed into the deferred candidate without truncating the
 * beginning of the utterance.
 */
export class GeminiTelnyxAcousticVad {
  private readonly minSpeechSamples: number;
  private readonly minSilenceSamples: number;
  private state: GeminiTelnyxAcousticVadSnapshot["state"] = "SILENCE";
  private candidateSpeechSamples = 0;
  private candidateSilenceSamples = 0;
  private processedSamples = 0;
  private onsetPayloads: string[] = [];

  constructor(private readonly config: GeminiTelnyxAcousticVadConfig) {
    if (!Number.isFinite(config.startRms) || config.startRms <= 0 || config.startRms > 1) {
      throw new Error("Gemini Telnyx acoustic VAD startRms must be in (0, 1]");
    }
    if (!Number.isFinite(config.stopRms) || config.stopRms < 0 || config.stopRms > config.startRms) {
      throw new Error("Gemini Telnyx acoustic VAD stopRms must be in [0, startRms]");
    }
    if (!Number.isFinite(config.minSpeechMs) || config.minSpeechMs <= 0) {
      throw new Error("Gemini Telnyx acoustic VAD minSpeechMs must be positive");
    }
    if (!Number.isFinite(config.minSilenceMs) || config.minSilenceMs <= 0) {
      throw new Error("Gemini Telnyx acoustic VAD minSilenceMs must be positive");
    }
    this.minSpeechSamples = msToSamples(config.minSpeechMs);
    this.minSilenceSamples = msToSamples(config.minSilenceMs);
  }

  observe(payload: string): GeminiTelnyxAcousticVadObservation {
    const normalized = payload.trim();
    const bytes = decodeBase64(normalized);
    const sampleCount = bytes.byteLength / 2;
    const rms = pcm16BeRms(bytes);
    this.processedSamples += sampleCount;

    let boundary: GeminiTelnyxAcousticVadBoundary | null = null;
    let shouldBufferPayload = this.state === "SPEECH";

    if (this.state === "SILENCE") {
      if (rms >= this.config.startRms) {
        this.candidateSpeechSamples += sampleCount;
        this.onsetPayloads.push(normalized);
        if (this.candidateSpeechSamples >= this.minSpeechSamples) {
          this.state = "SPEECH";
          boundary = Object.freeze({
            type: "SPEECH_START" as const,
            replayPayloads: Object.freeze([...this.onsetPayloads]),
          });
          shouldBufferPayload = false;
          this.candidateSpeechSamples = 0;
          this.candidateSilenceSamples = 0;
          this.onsetPayloads = [];
        }
      } else {
        this.candidateSpeechSamples = 0;
        this.onsetPayloads = [];
      }
    } else if (rms <= this.config.stopRms) {
      this.candidateSilenceSamples += sampleCount;
      shouldBufferPayload = true;
      if (this.candidateSilenceSamples >= this.minSilenceSamples) {
        this.state = "SILENCE";
        this.candidateSilenceSamples = 0;
        boundary = Object.freeze({ type: "SPEECH_END" as const });
      }
    } else {
      this.candidateSilenceSamples = 0;
      shouldBufferPayload = true;
    }

    return Object.freeze({
      boundary,
      rms,
      shouldBufferPayload,
      snapshot: this.snapshot(),
    });
  }

  reset(): GeminiTelnyxAcousticVadSnapshot {
    this.state = "SILENCE";
    this.candidateSpeechSamples = 0;
    this.candidateSilenceSamples = 0;
    this.onsetPayloads = [];
    return this.snapshot();
  }

  snapshot(): GeminiTelnyxAcousticVadSnapshot {
    return Object.freeze({
      state: this.state,
      candidateSpeechSamples: this.candidateSpeechSamples,
      candidateSilenceSamples: this.candidateSilenceSamples,
      processedSamples: this.processedSamples,
    });
  }
}
