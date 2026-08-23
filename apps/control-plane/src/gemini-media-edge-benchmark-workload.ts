export type GeminiMediaEdgeBenchmarkWorkload = Readonly<{
  schemaVersion: 1;
  workloadId: string;
  telnyxIngress: Readonly<{
    codec: "L16";
    sampleRateHz: 16000;
    channels: 1;
    frameDurationMs: 20;
  }>;
  geminiOutput: Readonly<{
    encoding: "PCM16_LE";
    sampleRateHz: 24000;
    channels: 1;
    frameDurationMs: 20;
  }>;
  deterministicAudio: Readonly<{
    generator: "SINE_PCM16";
    frequencyHz: number;
    amplitude: number;
    phaseSeed: number;
  }>;
  transport: Readonly<{
    callDurationSeconds: number;
    reorderWindowChunks: number;
    reorderPairEveryChunks: number;
    duplicateEveryChunks: number;
    slowPeerEveryCalls: number;
    slowPeerHoldMs: number;
  }>;
}>;

export const GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1: GeminiMediaEdgeBenchmarkWorkload = Object.freeze({
  schemaVersion: 1,
  workloadId: "gemini-media-edge-transport-v1",
  telnyxIngress: Object.freeze({
    codec: "L16" as const,
    sampleRateHz: 16000 as const,
    channels: 1 as const,
    frameDurationMs: 20 as const,
  }),
  geminiOutput: Object.freeze({
    encoding: "PCM16_LE" as const,
    sampleRateHz: 24000 as const,
    channels: 1 as const,
    frameDurationMs: 20 as const,
  }),
  deterministicAudio: Object.freeze({
    generator: "SINE_PCM16" as const,
    frequencyHz: 440,
    amplitude: 0.25,
    phaseSeed: 17,
  }),
  transport: Object.freeze({
    callDurationSeconds: 120,
    reorderWindowChunks: 64,
    reorderPairEveryChunks: 25,
    duplicateEveryChunks: 40,
    slowPeerEveryCalls: 10,
    slowPeerHoldMs: 250,
  }),
});

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function amplitude(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error("benchmark deterministicAudio.amplitude must be within (0, 1]");
  }
  return value;
}

/**
 * Validates the transport workload against the media contracts already enforced by
 * the Gemini/Telnyx bridge. This workload measures edge overhead deterministically;
 * provider semantic/model latency is intentionally outside this fingerprint.
 */
export function validateGeminiMediaEdgeBenchmarkWorkload(
  workload: GeminiMediaEdgeBenchmarkWorkload,
): GeminiMediaEdgeBenchmarkWorkload {
  if (workload.schemaVersion !== 1) throw new Error("Unsupported Gemini media edge workload schema version");
  if (workload.telnyxIngress?.codec !== "L16"
    || workload.telnyxIngress.sampleRateHz !== 16000
    || workload.telnyxIngress.channels !== 1
    || workload.telnyxIngress.frameDurationMs !== 20) {
    throw new Error("benchmark Telnyx ingress must be mono L16/16000 with 20 ms frames");
  }
  if (workload.geminiOutput?.encoding !== "PCM16_LE"
    || workload.geminiOutput.sampleRateHz !== 24000
    || workload.geminiOutput.channels !== 1
    || workload.geminiOutput.frameDurationMs !== 20) {
    throw new Error("benchmark Gemini output must be mono PCM16_LE/24000 with 20 ms frames");
  }
  if (workload.deterministicAudio?.generator !== "SINE_PCM16") {
    throw new Error("benchmark deterministic audio generator must be SINE_PCM16");
  }
  const frequencyHz = positiveInteger(workload.deterministicAudio.frequencyHz, "benchmark deterministicAudio.frequencyHz");
  if (frequencyHz >= workload.telnyxIngress.sampleRateHz / 2) {
    throw new Error("benchmark deterministicAudio.frequencyHz must remain below Nyquist");
  }
  const reorderWindowChunks = positiveInteger(workload.transport?.reorderWindowChunks, "benchmark transport.reorderWindowChunks");
  const reorderPairEveryChunks = positiveInteger(workload.transport?.reorderPairEveryChunks, "benchmark transport.reorderPairEveryChunks");
  if (reorderPairEveryChunks > reorderWindowChunks) {
    throw new Error("benchmark reorder injection must fit within the configured reorder window");
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    workloadId: required(workload.workloadId, "benchmark workloadId"),
    telnyxIngress: Object.freeze({ ...workload.telnyxIngress }),
    geminiOutput: Object.freeze({ ...workload.geminiOutput }),
    deterministicAudio: Object.freeze({
      generator: "SINE_PCM16" as const,
      frequencyHz,
      amplitude: amplitude(workload.deterministicAudio.amplitude),
      phaseSeed: positiveInteger(workload.deterministicAudio.phaseSeed, "benchmark deterministicAudio.phaseSeed"),
    }),
    transport: Object.freeze({
      callDurationSeconds: positiveInteger(workload.transport.callDurationSeconds, "benchmark transport.callDurationSeconds"),
      reorderWindowChunks,
      reorderPairEveryChunks,
      duplicateEveryChunks: positiveInteger(workload.transport.duplicateEveryChunks, "benchmark transport.duplicateEveryChunks"),
      slowPeerEveryCalls: positiveInteger(workload.transport.slowPeerEveryCalls, "benchmark transport.slowPeerEveryCalls"),
      slowPeerHoldMs: positiveInteger(workload.transport.slowPeerHoldMs, "benchmark transport.slowPeerHoldMs"),
    }),
  });
}

function canonicalWorkloadJson(workload: GeminiMediaEdgeBenchmarkWorkload): string {
  const validated = validateGeminiMediaEdgeBenchmarkWorkload(workload);
  return JSON.stringify({
    schemaVersion: validated.schemaVersion,
    workloadId: validated.workloadId,
    telnyxIngress: validated.telnyxIngress,
    geminiOutput: validated.geminiOutput,
    deterministicAudio: validated.deterministicAudio,
    transport: validated.transport,
  });
}

/** Stable SHA-256 identity used by benchmark evidence comparability checks. */
export async function geminiMediaEdgeBenchmarkWorkloadFingerprint(
  workload: GeminiMediaEdgeBenchmarkWorkload,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalWorkloadJson(workload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
