import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1,
  geminiMediaEdgeBenchmarkWorkloadFingerprint,
} from "../.test-dist/gemini-media-edge-benchmark-workload.js";
import {
  buildGeminiMediaEdgeBenchmarkEvidence,
  geminiMediaEdgeBenchmarkPercentile,
} from "../.test-dist/gemini-media-edge-benchmark-report.js";

const summary = Object.freeze({
  candidateId: "candidate-a",
  candidateRegion: "provider-eu-a",
  referenceRegion: "eu-west-reference",
  runId: "run-001",
  startedAt: "2026-08-23T16:00:00Z",
  durationSeconds: 120,
  concurrency: 10,
  completedCalls: 10,
  failedCalls: 0,
  reorderedFrames: 20,
  droppedFrames: 0,
  stableConcurrentConnections: 10,
  slowPeerClosures: 1,
  orphanedSessions: 0,
  estimatedCostPer1000CallMinutesUsd: 1.5,
});

function raw(overrides = {}) {
  return {
    telnyxToGeminiMs: [1, 2, 3, 4, 5],
    geminiToTelnyxMs: [2, 3, 4, 5, 6],
    telnyxSocketEstablishmentMs: [20, 30, 40, 50, 60],
    geminiSocketEstablishmentMs: [25, 35, 45, 55, 65],
    jitterMs: [0.5, 1, 1.5, 2, 2.5],
    cpuPercent: [10, 15, 12],
    memoryMiB: [100, 125, 120],
    ...overrides,
  };
}

test("nearest-rank percentile is deterministic at boundaries", () => {
  const values = [1, 2, 3, 4, 5];
  assert.equal(geminiMediaEdgeBenchmarkPercentile(values, 50), 3);
  assert.equal(geminiMediaEdgeBenchmarkPercentile(values, 95), 5);
  assert.equal(geminiMediaEdgeBenchmarkPercentile(values, 99), 5);
  assert.equal(geminiMediaEdgeBenchmarkPercentile(values, 100), 5);
});

test("raw samples produce canonical evidence with the workload fingerprint", async () => {
  const evidence = await buildGeminiMediaEdgeBenchmarkEvidence(
    GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1,
    summary,
    raw(),
  );
  const expectedFingerprint = await geminiMediaEdgeBenchmarkWorkloadFingerprint(GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1);

  assert.equal(evidence.workloadFingerprint, expectedFingerprint);
  assert.deepEqual(evidence.telnyxToGemini, { p50Ms: 3, p95Ms: 5, p99Ms: 5 });
  assert.deepEqual(evidence.geminiToTelnyx, { p50Ms: 4, p95Ms: 6, p99Ms: 6 });
  assert.equal(evidence.jitterP95Ms, 2.5);
  assert.equal(evidence.peakCpuPercent, 15);
  assert.equal(evidence.peakMemoryMiB, 125);
});

test("empty, negative and non-finite raw samples are rejected centrally", async () => {
  await assert.rejects(
    buildGeminiMediaEdgeBenchmarkEvidence(
      GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1,
      summary,
      raw({ telnyxToGeminiMs: [] }),
    ),
    /at least one sample/,
  );
  await assert.rejects(
    buildGeminiMediaEdgeBenchmarkEvidence(
      GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1,
      summary,
      raw({ cpuPercent: [10, -1] }),
    ),
    /finite non-negative/,
  );
  await assert.rejects(
    buildGeminiMediaEdgeBenchmarkEvidence(
      GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1,
      summary,
      raw({ memoryMiB: [100, Number.NaN] }),
    ),
    /finite non-negative/,
  );
});

test("invalid percentile requests fail instead of silently clamping", () => {
  assert.throws(() => geminiMediaEdgeBenchmarkPercentile([1, 2], 0), /within \(0, 100\]/);
  assert.throws(() => geminiMediaEdgeBenchmarkPercentile([1, 2], 101), /within \(0, 100\]/);
});
