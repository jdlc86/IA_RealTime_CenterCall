import {
  type GeminiMediaEdgeBenchmarkWorkload,
  validateGeminiMediaEdgeBenchmarkWorkload,
} from "./gemini-media-edge-benchmark-workload.js";

export type GeminiMediaEdgeBenchmarkIngressFrame = Readonly<{
  chunk: number;
  payloadBase64: string;
  duplicate: boolean;
}>;

export type GeminiMediaEdgeBenchmarkOutputFrame = Readonly<{
  chunk: number;
  payloadBase64: string;
}>;

export type GeminiMediaEdgeBenchmarkCallProfile = Readonly<{
  callIndex: number;
  slowPeer: boolean;
  slowPeerHoldMs: number;
}>;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sinePcm16Payload(
  chunk: number,
  sampleRateHz: number,
  frameDurationMs: number,
  workload: GeminiMediaEdgeBenchmarkWorkload,
  littleEndian: boolean,
): string {
  const samplesPerFrame = sampleRateHz * frameDurationMs / 1000;
  if (!Number.isSafeInteger(samplesPerFrame)) throw new Error("benchmark frame duration must produce an integral sample count");
  const bytes = new Uint8Array(samplesPerFrame * 2);
  const view = new DataView(bytes.buffer);
  const frequencyHz = workload.deterministicAudio.frequencyHz;
  const amplitude = workload.deterministicAudio.amplitude * 32767;
  const phaseSeed = workload.deterministicAudio.phaseSeed;
  const firstSample = (chunk - 1) * samplesPerFrame;

  for (let offset = 0; offset < samplesPerFrame; offset += 1) {
    const sampleIndex = firstSample + offset + phaseSeed;
    const radians = 2 * Math.PI * frequencyHz * sampleIndex / sampleRateHz;
    const sample = Math.round(Math.sin(radians) * amplitude);
    view.setInt16(offset * 2, sample, littleEndian);
  }
  return encodeBase64(bytes);
}

function ingressFramePayload(chunk: number, workload: GeminiMediaEdgeBenchmarkWorkload): string {
  // Telnyx RTP L16 uses network byte order (big-endian).
  return sinePcm16Payload(
    chunk,
    workload.telnyxIngress.sampleRateHz,
    workload.telnyxIngress.frameDurationMs,
    workload,
    false,
  );
}

function outputFramePayload(chunk: number, workload: GeminiMediaEdgeBenchmarkWorkload): string {
  // Gemini Live output PCM16 is little-endian at 24 kHz.
  return sinePcm16Payload(
    chunk,
    workload.geminiOutput.sampleRateHz,
    workload.geminiOutput.frameDurationMs,
    workload,
    true,
  );
}

function totalChunks(durationSeconds: number, frameDurationMs: number): number {
  const chunks = durationSeconds * 1000 / frameDurationMs;
  if (!Number.isSafeInteger(chunks) || chunks <= 0) throw new Error("benchmark call duration must produce a positive integral chunk count");
  return chunks;
}

/**
 * Streams one deterministic Telnyx ingress trace without materializing the full call.
 * Reorder injection swaps bounded adjacent pairs; duplicate injection re-emits the
 * same chunk immediately after its first appearance. There are intentionally no
 * missing chunks in the baseline transport benchmark because a permanent gap tests
 * terminal failure policy rather than steady-state relay overhead.
 */
export function* geminiMediaEdgeBenchmarkIngressTrace(
  input: GeminiMediaEdgeBenchmarkWorkload,
): Generator<GeminiMediaEdgeBenchmarkIngressFrame, void, undefined> {
  const workload = validateGeminiMediaEdgeBenchmarkWorkload(input);
  const count = totalChunks(workload.transport.callDurationSeconds, workload.telnyxIngress.frameDurationMs);
  const reorderEvery = workload.transport.reorderPairEveryChunks;
  const duplicateEvery = workload.transport.duplicateEveryChunks;

  const emit = function* (chunk: number): Generator<GeminiMediaEdgeBenchmarkIngressFrame, void, undefined> {
    const payloadBase64 = ingressFramePayload(chunk, workload);
    yield Object.freeze({ chunk, payloadBase64, duplicate: false });
    if (chunk % duplicateEvery === 0) {
      yield Object.freeze({ chunk, payloadBase64, duplicate: true });
    }
  };

  for (let chunk = 1; chunk <= count; chunk += 1) {
    if (chunk % reorderEvery === 0 && chunk < count) {
      yield* emit(chunk + 1);
      yield* emit(chunk);
      chunk += 1;
      continue;
    }
    yield* emit(chunk);
  }
}

/**
 * Streams deterministic Gemini PCM16/24 kHz output frames. The harness must feed
 * these frames through one session-owned Pcm16Resampler, matching the production
 * Gemini -> Telnyx hot path rather than benchmarking pre-resampled audio.
 */
export function* geminiMediaEdgeBenchmarkOutputTrace(
  input: GeminiMediaEdgeBenchmarkWorkload,
): Generator<GeminiMediaEdgeBenchmarkOutputFrame, void, undefined> {
  const workload = validateGeminiMediaEdgeBenchmarkWorkload(input);
  const count = totalChunks(workload.transport.callDurationSeconds, workload.geminiOutput.frameDurationMs);
  for (let chunk = 1; chunk <= count; chunk += 1) {
    yield Object.freeze({ chunk, payloadBase64: outputFramePayload(chunk, workload) });
  }
}

/** Per-call deterministic backpressure profile used by every benchmark candidate. */
export function geminiMediaEdgeBenchmarkCallProfile(
  callIndex: number,
  input: GeminiMediaEdgeBenchmarkWorkload,
): GeminiMediaEdgeBenchmarkCallProfile {
  if (!Number.isSafeInteger(callIndex) || callIndex <= 0) {
    throw new Error("benchmark callIndex must be a positive safe integer");
  }
  const workload = validateGeminiMediaEdgeBenchmarkWorkload(input);
  const slowPeer = callIndex % workload.transport.slowPeerEveryCalls === 0;
  return Object.freeze({
    callIndex,
    slowPeer,
    slowPeerHoldMs: slowPeer ? workload.transport.slowPeerHoldMs : 0,
  });
}
