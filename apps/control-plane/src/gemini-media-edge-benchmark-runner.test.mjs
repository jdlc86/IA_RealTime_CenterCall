import test from "node:test";
import assert from "node:assert/strict";
import { GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1 } from "../.test-dist/gemini-media-edge-benchmark-workload.js";
import { runGeminiMediaEdgeBenchmarkCandidate } from "../.test-dist/gemini-media-edge-benchmark-runner.js";

function runInput(overrides = {}) {
  return {
    candidateId: "candidate-a",
    candidateRegion: "provider-eu-a",
    referenceRegion: "eu-west-reference",
    runId: "run-a",
    concurrency: 2,
    attemptedCalls: 4,
    estimatedCostPer1000CallMinutesUsd: 1.5,
    workload: {
      ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1,
      transport: {
        ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.transport,
        callDurationSeconds: 1,
      },
    },
    ...overrides,
  };
}

function clock(...values) {
  let index = 0;
  return {
    nowEpochMs() {
      const value = values[Math.min(index, values.length - 1)];
      index += 1;
      return value;
    },
  };
}

function observation(callIndex, overrides = {}) {
  return {
    outcome: "COMPLETED",
    telnyxToGeminiMs: [callIndex, callIndex + 0.5],
    geminiToTelnyxMs: [callIndex + 1],
    telnyxSocketEstablishmentMs: [10 + callIndex],
    geminiSocketEstablishmentMs: [20 + callIndex],
    jitterMs: [0.5 + callIndex / 10],
    cpuPercent: [30 + callIndex],
    memoryMiB: [100 + callIndex],
    reorderedFrames: 1,
    droppedFrames: 0,
    slowPeerClosed: false,
    orphanedSession: false,
    ...overrides,
  };
}

test("runner owns concurrency, deterministic traces and canonical evidence", async () => {
  let active = 0;
  let maxActive = 0;
  const seenCalls = [];
  const adapter = {
    async executeCall(call) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      call.lifecycle.markStable();
      seenCalls.push({
        callIndex: call.callIndex,
        profile: call.profile,
        ingressFirst: call.ingressTrace().next().value,
        outputFirst: call.geminiOutputTrace().next().value,
      });
      await Promise.resolve();
      call.lifecycle.markUnstable();
      active -= 1;
      return observation(call.callIndex, {
        outcome: call.callIndex === 4 ? "FAILED" : "COMPLETED",
        droppedFrames: call.callIndex === 4 ? 2 : 0,
        orphanedSession: call.callIndex === 4,
      });
    },
  };

  const evidence = await runGeminiMediaEdgeBenchmarkCandidate(
    runInput(),
    adapter,
    clock(1_000, 3_500),
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(seenCalls.map((entry) => entry.callIndex), [1, 2, 3, 4]);
  assert.equal(seenCalls.every((entry) => entry.ingressFirst.payloadBase64.length > 0), true);
  assert.equal(seenCalls.every((entry) => entry.outputFirst.payloadBase64.length > 0), true);
  assert.equal(evidence.concurrency, 2);
  assert.equal(evidence.completedCalls, 3);
  assert.equal(evidence.failedCalls, 1);
  assert.equal(evidence.stableConcurrentConnections, 2);
  assert.equal(evidence.reorderedFrames, 4);
  assert.equal(evidence.droppedFrames, 2);
  assert.equal(evidence.orphanedSessions, 1);
  assert.equal(evidence.durationSeconds, 3);
  assert.match(evidence.workloadFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(evidence.telnyxToGemini, { p50Ms: 2.5, p95Ms: 4.5, p99Ms: 4.5 });
});

test("runner rejects call volume smaller than configured concurrency before adapter effects", async () => {
  let calls = 0;
  await assert.rejects(
    runGeminiMediaEdgeBenchmarkCandidate(
      runInput({ concurrency: 3, attemptedCalls: 2 }),
      { async executeCall() { calls += 1; return observation(1); } },
      clock(1_000, 2_000),
    ),
    /attemptedCalls must be greater than or equal to concurrency/,
  );
  assert.equal(calls, 0);
});

test("runner fails closed when candidate returns while stable ownership is still held", async () => {
  await assert.rejects(
    runGeminiMediaEdgeBenchmarkCandidate(
      runInput({ concurrency: 1, attemptedCalls: 1 }),
      {
        async executeCall(call) {
          call.lifecycle.markStable();
          return observation(1);
        },
      },
      clock(1_000, 2_000),
    ),
    /returned while still marked stable/,
  );
});

test("runner rejects invalid candidate counters instead of normalizing them", async () => {
  await assert.rejects(
    runGeminiMediaEdgeBenchmarkCandidate(
      runInput({ concurrency: 1, attemptedCalls: 1 }),
      {
        async executeCall(call) {
          call.lifecycle.markStable();
          call.lifecycle.markUnstable();
          return observation(1, { reorderedFrames: -1 });
        },
      },
      clock(1_000, 2_000),
    ),
    /reorderedFrames must be a non-negative safe integer/,
  );
});
