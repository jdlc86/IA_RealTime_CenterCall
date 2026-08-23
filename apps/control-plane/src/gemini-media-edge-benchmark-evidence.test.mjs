import test from "node:test";
import assert from "node:assert/strict";
import {
  requireComparableGeminiMediaEdgeBenchmarks,
  validateGeminiMediaEdgeBenchmarkEvidence,
} from "../.test-dist/gemini-media-edge-benchmark-evidence.js";

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    candidateId: "candidate-a",
    candidateRegion: "provider-region-a",
    referenceRegion: "eu-west-reference",
    workloadFingerprint: "sha256:fixture-v1",
    runId: "run-a",
    startedAt: "2026-08-23T16:00:00Z",
    durationSeconds: 1800,
    concurrency: 25,
    completedCalls: 25,
    failedCalls: 0,
    telnyxToGemini: { p50Ms: 4, p95Ms: 8, p99Ms: 12 },
    geminiToTelnyx: { p50Ms: 5, p95Ms: 9, p99Ms: 13 },
    telnyxSocketEstablishment: { p50Ms: 30, p95Ms: 50, p99Ms: 70 },
    geminiSocketEstablishment: { p50Ms: 35, p95Ms: 55, p99Ms: 75 },
    jitterP95Ms: 3,
    reorderedFrames: 4,
    droppedFrames: 0,
    peakCpuPercent: 42,
    peakMemoryMiB: 256,
    stableConcurrentConnections: 25,
    slowPeerClosures: 1,
    orphanedSessions: 0,
    estimatedCostPer1000CallMinutesUsd: 1.25,
    ...overrides,
  };
}

test("one benchmark result validates without inventing a winner", () => {
  const validated = validateGeminiMediaEdgeBenchmarkEvidence(evidence());
  assert.equal(validated.candidateId, "candidate-a");
  assert.deepEqual(validated.telnyxToGemini, { p50Ms: 4, p95Ms: 8, p99Ms: 12 });
});

test("percentiles must be monotonic and finite", () => {
  assert.throws(
    () => validateGeminiMediaEdgeBenchmarkEvidence(evidence({
      telnyxToGemini: { p50Ms: 10, p95Ms: 9, p99Ms: 12 },
    })),
    /p50 <= p95 <= p99/,
  );
  assert.throws(
    () => validateGeminiMediaEdgeBenchmarkEvidence(evidence({ jitterP95Ms: Number.NaN })),
    /finite non-negative/,
  );
});

test("comparison requires at least two distinct candidates", () => {
  assert.throws(
    () => requireComparableGeminiMediaEdgeBenchmarks([evidence()]),
    /at least two candidate results/,
  );
  assert.throws(
    () => requireComparableGeminiMediaEdgeBenchmarks([
      evidence({ runId: "run-1" }),
      evidence({ runId: "run-2", candidateRegion: "provider-region-b" }),
    ]),
    /at least two distinct candidates/,
  );
});

test("comparison rejects workload, region, duration and concurrency drift", () => {
  const baseline = evidence();
  const variants = [
    [evidence({ candidateId: "candidate-b", workloadFingerprint: "sha256:other" }), /workloads are not comparable/],
    [evidence({ candidateId: "candidate-b", referenceRegion: "us-reference" }), /reference regions are not comparable/],
    [evidence({ candidateId: "candidate-b", durationSeconds: 900 }), /durations are not comparable/],
    [evidence({ candidateId: "candidate-b", concurrency: 50 }), /concurrency is not comparable/],
  ];

  for (const [candidate, pattern] of variants) {
    assert.throws(() => requireComparableGeminiMediaEdgeBenchmarks([baseline, candidate]), pattern);
  }
});

test("provider-specific region names may differ when reference region and workload match", () => {
  const comparable = requireComparableGeminiMediaEdgeBenchmarks([
    evidence(),
    evidence({
      candidateId: "candidate-b",
      candidateRegion: "different-provider-eu-region",
      runId: "run-b",
    }),
  ]);

  assert.equal(comparable.candidates.length, 2);
  assert.equal(comparable.referenceRegion, "eu-west-reference");
  assert.equal(comparable.workloadFingerprint, "sha256:fixture-v1");
});
