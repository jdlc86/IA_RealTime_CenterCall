export type GeminiMediaEdgeLatencyPercentiles = Readonly<{
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}>;

export type GeminiMediaEdgeBenchmarkEvidence = Readonly<{
  schemaVersion: 1;
  candidateId: string;
  candidateRegion: string;
  referenceRegion: string;
  workloadFingerprint: string;
  runId: string;
  startedAt: string;
  durationSeconds: number;
  concurrency: number;
  completedCalls: number;
  failedCalls: number;
  telnyxToGemini: GeminiMediaEdgeLatencyPercentiles;
  geminiToTelnyx: GeminiMediaEdgeLatencyPercentiles;
  telnyxSocketEstablishment: GeminiMediaEdgeLatencyPercentiles;
  geminiSocketEstablishment: GeminiMediaEdgeLatencyPercentiles;
  jitterP95Ms: number;
  reorderedFrames: number;
  droppedFrames: number;
  peakCpuPercent: number;
  peakMemoryMiB: number;
  stableConcurrentConnections: number;
  slowPeerClosures: number;
  orphanedSessions: number;
  estimatedCostPer1000CallMinutesUsd: number;
}>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function workloadFingerprint(value: unknown): string {
  const normalized = required(value, "benchmark workloadFingerprint").toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("benchmark workloadFingerprint must be sha256:<64 lowercase hex characters>");
  }
  return normalized;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function latency(value: GeminiMediaEdgeLatencyPercentiles, field: string): GeminiMediaEdgeLatencyPercentiles {
  const p50Ms = finiteNonNegative(value?.p50Ms, `${field}.p50Ms`);
  const p95Ms = finiteNonNegative(value?.p95Ms, `${field}.p95Ms`);
  const p99Ms = finiteNonNegative(value?.p99Ms, `${field}.p99Ms`);
  if (p50Ms > p95Ms || p95Ms > p99Ms) throw new Error(`${field} percentiles must satisfy p50 <= p95 <= p99`);
  return Object.freeze({ p50Ms, p95Ms, p99Ms });
}

/**
 * Validates one immutable benchmark result. It deliberately does not score or rank
 * providers; accepting a media-edge platform requires observed evidence plus an
 * explicit architectural decision, not a hidden weighting function.
 */
export function validateGeminiMediaEdgeBenchmarkEvidence(
  evidence: GeminiMediaEdgeBenchmarkEvidence,
): GeminiMediaEdgeBenchmarkEvidence {
  if (evidence.schemaVersion !== 1) throw new Error("Unsupported Gemini media edge benchmark schema version");
  const startedAt = required(evidence.startedAt, "benchmark startedAt");
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error("benchmark startedAt must be an ISO-compatible timestamp");
  const completedCalls = nonNegativeInteger(evidence.completedCalls, "benchmark completedCalls");
  const failedCalls = nonNegativeInteger(evidence.failedCalls, "benchmark failedCalls");
  if (completedCalls + failedCalls === 0) throw new Error("benchmark must contain at least one attempted call");
  const concurrency = positiveInteger(evidence.concurrency, "benchmark concurrency");
  const stableConcurrentConnections = nonNegativeInteger(
    evidence.stableConcurrentConnections,
    "benchmark stableConcurrentConnections",
  );
  if (stableConcurrentConnections > concurrency) {
    throw new Error("benchmark stableConcurrentConnections cannot exceed configured concurrency");
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    candidateId: required(evidence.candidateId, "benchmark candidateId"),
    candidateRegion: required(evidence.candidateRegion, "benchmark candidateRegion"),
    referenceRegion: required(evidence.referenceRegion, "benchmark referenceRegion"),
    workloadFingerprint: workloadFingerprint(evidence.workloadFingerprint),
    runId: required(evidence.runId, "benchmark runId"),
    startedAt,
    durationSeconds: positiveInteger(evidence.durationSeconds, "benchmark durationSeconds"),
    concurrency,
    completedCalls,
    failedCalls,
    telnyxToGemini: latency(evidence.telnyxToGemini, "benchmark telnyxToGemini"),
    geminiToTelnyx: latency(evidence.geminiToTelnyx, "benchmark geminiToTelnyx"),
    telnyxSocketEstablishment: latency(evidence.telnyxSocketEstablishment, "benchmark telnyxSocketEstablishment"),
    geminiSocketEstablishment: latency(evidence.geminiSocketEstablishment, "benchmark geminiSocketEstablishment"),
    jitterP95Ms: finiteNonNegative(evidence.jitterP95Ms, "benchmark jitterP95Ms"),
    reorderedFrames: nonNegativeInteger(evidence.reorderedFrames, "benchmark reorderedFrames"),
    droppedFrames: nonNegativeInteger(evidence.droppedFrames, "benchmark droppedFrames"),
    peakCpuPercent: finiteNonNegative(evidence.peakCpuPercent, "benchmark peakCpuPercent"),
    peakMemoryMiB: finiteNonNegative(evidence.peakMemoryMiB, "benchmark peakMemoryMiB"),
    stableConcurrentConnections,
    slowPeerClosures: nonNegativeInteger(evidence.slowPeerClosures, "benchmark slowPeerClosures"),
    orphanedSessions: nonNegativeInteger(evidence.orphanedSessions, "benchmark orphanedSessions"),
    estimatedCostPer1000CallMinutesUsd: finiteNonNegative(
      evidence.estimatedCostPer1000CallMinutesUsd,
      "benchmark estimatedCostPer1000CallMinutesUsd",
    ),
  });
}

export type GeminiMediaEdgeComparableBenchmarkSet = Readonly<{
  referenceRegion: string;
  workloadFingerprint: string;
  durationSeconds: number;
  concurrency: number;
  candidates: readonly GeminiMediaEdgeBenchmarkEvidence[];
}>;

/**
 * Requires at least two distinct candidates measured under the same workload,
 * reference region, duration and concurrency. Candidate deployment regions may have
 * provider-specific names, so comparability is anchored to referenceRegion rather
 * than requiring identical region strings from unrelated platforms.
 */
export function requireComparableGeminiMediaEdgeBenchmarks(
  evidence: readonly GeminiMediaEdgeBenchmarkEvidence[],
): GeminiMediaEdgeComparableBenchmarkSet {
  if (!Array.isArray(evidence) || evidence.length < 2) {
    throw new Error("Gemini media edge benchmark requires at least two candidate results");
  }
  const validated = evidence.map(validateGeminiMediaEdgeBenchmarkEvidence);
  const first = validated[0];
  const candidateIds = new Set(validated.map((item) => item.candidateId));
  if (candidateIds.size < 2) throw new Error("Gemini media edge benchmark requires at least two distinct candidates");

  for (const item of validated.slice(1)) {
    if (item.referenceRegion !== first.referenceRegion) throw new Error("Gemini media edge benchmark reference regions are not comparable");
    if (item.workloadFingerprint !== first.workloadFingerprint) throw new Error("Gemini media edge benchmark workloads are not comparable");
    if (item.durationSeconds !== first.durationSeconds) throw new Error("Gemini media edge benchmark durations are not comparable");
    if (item.concurrency !== first.concurrency) throw new Error("Gemini media edge benchmark concurrency is not comparable");
  }

  return Object.freeze({
    referenceRegion: first.referenceRegion,
    workloadFingerprint: first.workloadFingerprint,
    durationSeconds: first.durationSeconds,
    concurrency: first.concurrency,
    candidates: Object.freeze(validated.slice()),
  });
}
