import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1,
} from "../.test-dist/gemini-media-edge-benchmark-workload.js";
import {
  geminiMediaEdgeBenchmarkCallProfile,
  geminiMediaEdgeBenchmarkIngressTrace,
} from "../.test-dist/gemini-media-edge-benchmark-trace.js";

function workload(overrides = {}) {
  return {
    ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1,
    transport: {
      ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.transport,
      callDurationSeconds: 1,
      ...overrides,
    },
  };
}

test("trace emits 20 ms L16 frames with deterministic bounded reordering", () => {
  const frames = Array.from(geminiMediaEdgeBenchmarkIngressTrace(workload()));
  const chunks = frames.filter((frame) => !frame.duplicate).map((frame) => frame.chunk);

  assert.equal(chunks.length, 50);
  assert.deepEqual(chunks.slice(22, 28), [23, 24, 26, 25, 27, 28]);
  assert.deepEqual(chunks.slice(47), [48, 49, 50]);
  assert.equal(frames[0].payloadBase64.length > 0, true);
});

test("duplicate injection re-emits the exact payload and marks only the replay", () => {
  const frames = Array.from(geminiMediaEdgeBenchmarkIngressTrace(workload()));
  const chunk40 = frames.filter((frame) => frame.chunk === 40);

  assert.equal(chunk40.length, 2);
  assert.equal(chunk40[0].duplicate, false);
  assert.equal(chunk40[1].duplicate, true);
  assert.equal(chunk40[0].payloadBase64, chunk40[1].payloadBase64);
});

test("same workload produces byte-identical trace prefixes", () => {
  const first = Array.from(geminiMediaEdgeBenchmarkIngressTrace(workload())).slice(0, 12);
  const second = Array.from(geminiMediaEdgeBenchmarkIngressTrace(workload())).slice(0, 12);
  assert.deepEqual(second, first);
});

test("slow-peer profile is deterministic per call and does not affect other calls", () => {
  const normal = geminiMediaEdgeBenchmarkCallProfile(9, workload());
  const slow = geminiMediaEdgeBenchmarkCallProfile(10, workload());
  const next = geminiMediaEdgeBenchmarkCallProfile(11, workload());

  assert.deepEqual(normal, { callIndex: 9, slowPeer: false, slowPeerHoldMs: 0 });
  assert.deepEqual(slow, { callIndex: 10, slowPeer: true, slowPeerHoldMs: 250 });
  assert.deepEqual(next, { callIndex: 11, slowPeer: false, slowPeerHoldMs: 0 });
});

test("call profile rejects non-positive and fractional call identities", () => {
  assert.throws(() => geminiMediaEdgeBenchmarkCallProfile(0, workload()), /positive safe integer/);
  assert.throws(() => geminiMediaEdgeBenchmarkCallProfile(1.5, workload()), /positive safe integer/);
});
