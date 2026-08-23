import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1,
  geminiMediaEdgeBenchmarkWorkloadFingerprint,
  validateGeminiMediaEdgeBenchmarkWorkload,
} from "../.test-dist/gemini-media-edge-benchmark-workload.js";

function clone(overrides = {}) {
  return {
    ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1,
    telnyxIngress: { ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.telnyxIngress },
    geminiOutput: { ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.geminiOutput },
    deterministicAudio: { ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.deterministicAudio },
    transport: { ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.transport },
    ...overrides,
  };
}

test("canonical v1 workload matches the enforced Telnyx/Gemini media contracts", () => {
  const workload = validateGeminiMediaEdgeBenchmarkWorkload(GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1);
  assert.deepEqual(workload.telnyxIngress, {
    codec: "L16",
    sampleRateHz: 16000,
    channels: 1,
    frameDurationMs: 20,
  });
  assert.deepEqual(workload.geminiOutput, {
    encoding: "PCM16_LE",
    sampleRateHz: 24000,
    channels: 1,
    frameDurationMs: 20,
  });
});

test("fingerprint is deterministic, sha256 shaped and changes on workload drift", async () => {
  const first = await geminiMediaEdgeBenchmarkWorkloadFingerprint(clone());
  const second = await geminiMediaEdgeBenchmarkWorkloadFingerprint(clone());
  const drifted = await geminiMediaEdgeBenchmarkWorkloadFingerprint(clone({
    transport: {
      ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.transport,
      slowPeerHoldMs: 251,
    },
  }));

  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(second, first);
  assert.notEqual(drifted, first);
});

test("unsupported audio contracts fail before a benchmark can be fingerprinted", async () => {
  await assert.rejects(
    geminiMediaEdgeBenchmarkWorkloadFingerprint(clone({
      telnyxIngress: {
        ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.telnyxIngress,
        sampleRateHz: 8000,
      },
    })),
    /mono L16\/16000/,
  );
  await assert.rejects(
    geminiMediaEdgeBenchmarkWorkloadFingerprint(clone({
      geminiOutput: {
        ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.geminiOutput,
        sampleRateHz: 16000,
      },
    })),
    /PCM16_LE\/24000/,
  );
});

test("reorder injection must remain inside the production reorder window", () => {
  assert.throws(
    () => validateGeminiMediaEdgeBenchmarkWorkload(clone({
      transport: {
        ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.transport,
        reorderWindowChunks: 8,
        reorderPairEveryChunks: 9,
      },
    })),
    /fit within the configured reorder window/,
  );
});

test("deterministic audio parameters are bounded and below Nyquist", () => {
  assert.throws(
    () => validateGeminiMediaEdgeBenchmarkWorkload(clone({
      deterministicAudio: {
        ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.deterministicAudio,
        amplitude: 1.1,
      },
    })),
    /within \(0, 1\]/,
  );
  assert.throws(
    () => validateGeminiMediaEdgeBenchmarkWorkload(clone({
      deterministicAudio: {
        ...GEMINI_MEDIA_EDGE_BENCHMARK_WORKLOAD_V1.deterministicAudio,
        frequencyHz: 8000,
      },
    })),
    /below Nyquist/,
  );
});
