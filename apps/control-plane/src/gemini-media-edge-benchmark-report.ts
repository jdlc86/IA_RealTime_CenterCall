import {
  type GeminiMediaEdgeBenchmarkEvidence,
  type GeminiMediaEdgeLatencyPercentiles,
  validateGeminiMediaEdgeBenchmarkEvidence,
} from "./gemini-media-edge-benchmark-evidence.js";
import {
  type GeminiMediaEdgeBenchmarkWorkload,
  geminiMediaEdgeBenchmarkWorkloadFingerprint,
} from "./gemini-media-edge-benchmark-workload.js";

export type GeminiMediaEdgeBenchmarkRawSamples = Readonly<{
  telnyxToGeminiMs: readonly number[];
  geminiToTelnyxMs: readonly number[];
  telnyxSocketEstablishmentMs: readonly number[];
  geminiSocketEstablishmentMs: readonly number[];
  jitterMs: readonly number[];
  cpuPercent: readonly number[];
  memoryMiB: readonly number[];
}>;

export type GeminiMediaEdgeBenchmarkRunSummary = Readonly<{
  candidateId: string;
  candidateRegion: string;
  referenceRegion: string;
  runId: string;
  startedAt: string;
  durationSeconds: number;
  concurrency: number;
  completedCalls: number;
  failedCalls: number;
  reorderedFrames: number;
  droppedFrames: number;
  stableConcurrentConnections: number;
  slowPeerClosures: number;
  orphanedSessions: number;
  estimatedCostPer1000CallMinutesUsd: number;
}>;

function finiteSamples(values: readonly number[], field: string): number[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${field} must contain at least one sample`);
  const normalized = values.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${field} samples must be finite non-negative numbers`);
    }
    return value;
  });
  return normalized;
}

/**
 * Deterministic nearest-rank percentile. Every candidate is therefore summarized
 * with exactly the same algorithm rather than platform-specific percentile rules.
 */
export function geminiMediaEdgeBenchmarkPercentile(
  values: readonly number[],
  percentile: number,
): number {
  const samples = finiteSamples(values, "benchmark percentile").sort((a, b) => a - b);
  if (typeof percentile !== "number" || !Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error("benchmark percentile must be within (0, 100]");
  }
  const rank = Math.ceil(percentile / 100 * samples.length);
  return samples[Math.max(0, rank - 1)];
}

function latency(values: readonly number[], field: string): GeminiMediaEdgeLatencyPercentiles {
  const samples = finiteSamples(values, field);
  return Object.freeze({
    p50Ms: geminiMediaEdgeBenchmarkPercentile(samples, 50),
    p95Ms: geminiMediaEdgeBenchmarkPercentile(samples, 95),
    p99Ms: geminiMediaEdgeBenchmarkPercentile(samples, 99),
  });
}

function peak(values: readonly number[], field: string): number {
  return Math.max(...finiteSamples(values, field));
}

/**
 * Converts raw candidate observations into canonical benchmark evidence. Network
 * execution remains hosting-specific, but statistics, workload identity and final
 * evidence validation are repository-owned and identical for every candidate.
 */
export async function buildGeminiMediaEdgeBenchmarkEvidence(
  workload: GeminiMediaEdgeBenchmarkWorkload,
  summary: GeminiMediaEdgeBenchmarkRunSummary,
  raw: GeminiMediaEdgeBenchmarkRawSamples,
): Promise<GeminiMediaEdgeBenchmarkEvidence> {
  const workloadFingerprint = await geminiMediaEdgeBenchmarkWorkloadFingerprint(workload);
  const evidence: GeminiMediaEdgeBenchmarkEvidence = {
    schemaVersion: 1,
    candidateId: summary.candidateId,
    candidateRegion: summary.candidateRegion,
    referenceRegion: summary.referenceRegion,
    workloadFingerprint,
    runId: summary.runId,
    startedAt: summary.startedAt,
    durationSeconds: summary.durationSeconds,
    concurrency: summary.concurrency,
    completedCalls: summary.completedCalls,
    failedCalls: summary.failedCalls,
    telnyxToGemini: latency(raw.telnyxToGeminiMs, "benchmark telnyxToGeminiMs"),
    geminiToTelnyx: latency(raw.geminiToTelnyxMs, "benchmark geminiToTelnyxMs"),
    telnyxSocketEstablishment: latency(raw.telnyxSocketEstablishmentMs, "benchmark telnyxSocketEstablishmentMs"),
    geminiSocketEstablishment: latency(raw.geminiSocketEstablishmentMs, "benchmark geminiSocketEstablishmentMs"),
    jitterP95Ms: geminiMediaEdgeBenchmarkPercentile(finiteSamples(raw.jitterMs, "benchmark jitterMs"), 95),
    reorderedFrames: summary.reorderedFrames,
    droppedFrames: summary.droppedFrames,
    peakCpuPercent: peak(raw.cpuPercent, "benchmark cpuPercent"),
    peakMemoryMiB: peak(raw.memoryMiB, "benchmark memoryMiB"),
    stableConcurrentConnections: summary.stableConcurrentConnections,
    slowPeerClosures: summary.slowPeerClosures,
    orphanedSessions: summary.orphanedSessions,
    estimatedCostPer1000CallMinutesUsd: summary.estimatedCostPer1000CallMinutesUsd,
  };
  return validateGeminiMediaEdgeBenchmarkEvidence(evidence);
}
