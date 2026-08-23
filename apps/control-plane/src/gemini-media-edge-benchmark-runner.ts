import {
  buildGeminiMediaEdgeBenchmarkEvidence,
  type GeminiMediaEdgeBenchmarkRawSamples,
} from "./gemini-media-edge-benchmark-report.js";
import {
  geminiMediaEdgeBenchmarkCallProfile,
  geminiMediaEdgeBenchmarkIngressTrace,
  geminiMediaEdgeBenchmarkOutputTrace,
  type GeminiMediaEdgeBenchmarkCallProfile,
  type GeminiMediaEdgeBenchmarkIngressFrame,
  type GeminiMediaEdgeBenchmarkOutputFrame,
} from "./gemini-media-edge-benchmark-trace.js";
import {
  type GeminiMediaEdgeBenchmarkWorkload,
  validateGeminiMediaEdgeBenchmarkWorkload,
} from "./gemini-media-edge-benchmark-workload.js";
import type { GeminiMediaEdgeBenchmarkEvidence } from "./gemini-media-edge-benchmark-evidence.js";

export type GeminiMediaEdgeBenchmarkCallLifecycle = Readonly<{
  markStable(): void;
  markUnstable(): void;
}>;

export type GeminiMediaEdgeBenchmarkCandidateCall = Readonly<{
  callIndex: number;
  workload: GeminiMediaEdgeBenchmarkWorkload;
  profile: GeminiMediaEdgeBenchmarkCallProfile;
  ingressTrace(): Generator<GeminiMediaEdgeBenchmarkIngressFrame, void, undefined>;
  geminiOutputTrace(): Generator<GeminiMediaEdgeBenchmarkOutputFrame, void, undefined>;
  lifecycle: GeminiMediaEdgeBenchmarkCallLifecycle;
}>;

export type GeminiMediaEdgeBenchmarkCandidateCallObservation = Readonly<{
  outcome: "COMPLETED" | "FAILED";
  telnyxToGeminiMs: readonly number[];
  geminiToTelnyxMs: readonly number[];
  telnyxSocketEstablishmentMs: readonly number[];
  geminiSocketEstablishmentMs: readonly number[];
  jitterMs: readonly number[];
  cpuPercent: readonly number[];
  memoryMiB: readonly number[];
  reorderedFrames: number;
  droppedFrames: number;
  slowPeerClosed: boolean;
  orphanedSession: boolean;
}>;

export type GeminiMediaEdgeBenchmarkCandidateAdapter = Readonly<{
  executeCall(
    input: GeminiMediaEdgeBenchmarkCandidateCall,
  ): Promise<GeminiMediaEdgeBenchmarkCandidateCallObservation>;
}>;

export type GeminiMediaEdgeBenchmarkRunInput = Readonly<{
  candidateId: string;
  candidateRegion: string;
  referenceRegion: string;
  runId: string;
  concurrency: number;
  attemptedCalls: number;
  estimatedCostPer1000CallMinutesUsd: number;
  workload: GeminiMediaEdgeBenchmarkWorkload;
}>;

export type GeminiMediaEdgeBenchmarkClock = Readonly<{
  nowEpochMs(): number;
}>;

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

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

function finiteEpoch(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative epoch value`);
  }
  return value;
}

function append(target: number[], values: readonly number[]): void {
  for (const value of values) target.push(value);
}

/**
 * Executes one candidate through repository-owned scheduling and evidence rules.
 *
 * The candidate owns only hosting-specific I/O and raw observations. The repository
 * owns call volume, concurrency, deterministic traces, stable-connection counting,
 * run duration, percentile calculation and workload fingerprinting. This prevents
 * candidate implementations from silently changing benchmark semantics.
 */
export async function runGeminiMediaEdgeBenchmarkCandidate(
  input: GeminiMediaEdgeBenchmarkRunInput,
  adapter: GeminiMediaEdgeBenchmarkCandidateAdapter,
  clock: GeminiMediaEdgeBenchmarkClock,
): Promise<GeminiMediaEdgeBenchmarkEvidence> {
  const candidateId = required(input.candidateId, "benchmark candidateId");
  const candidateRegion = required(input.candidateRegion, "benchmark candidateRegion");
  const referenceRegion = required(input.referenceRegion, "benchmark referenceRegion");
  const runId = required(input.runId, "benchmark runId");
  const concurrency = positiveInteger(input.concurrency, "benchmark concurrency");
  const attemptedCalls = positiveInteger(input.attemptedCalls, "benchmark attemptedCalls");
  if (attemptedCalls < concurrency) {
    throw new Error("benchmark attemptedCalls must be greater than or equal to concurrency");
  }
  const estimatedCostPer1000CallMinutesUsd = finiteNonNegative(
    input.estimatedCostPer1000CallMinutesUsd,
    "benchmark estimatedCostPer1000CallMinutesUsd",
  );
  const workload = validateGeminiMediaEdgeBenchmarkWorkload(input.workload);
  if (!adapter || typeof adapter.executeCall !== "function") throw new Error("benchmark candidate adapter executeCall is required");
  if (!clock || typeof clock.nowEpochMs !== "function") throw new Error("benchmark clock nowEpochMs is required");

  const startedEpochMs = finiteEpoch(clock.nowEpochMs(), "benchmark start time");
  const startedAt = new Date(startedEpochMs).toISOString();
  const raw: {
    telnyxToGeminiMs: number[];
    geminiToTelnyxMs: number[];
    telnyxSocketEstablishmentMs: number[];
    geminiSocketEstablishmentMs: number[];
    jitterMs: number[];
    cpuPercent: number[];
    memoryMiB: number[];
  } = {
    telnyxToGeminiMs: [],
    geminiToTelnyxMs: [],
    telnyxSocketEstablishmentMs: [],
    geminiSocketEstablishmentMs: [],
    jitterMs: [],
    cpuPercent: [],
    memoryMiB: [],
  };

  let nextCallIndex = 1;
  let completedCalls = 0;
  let failedCalls = 0;
  let reorderedFrames = 0;
  let droppedFrames = 0;
  let slowPeerClosures = 0;
  let orphanedSessions = 0;
  let stableNow = 0;
  let stablePeak = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const callIndex = nextCallIndex;
      if (callIndex > attemptedCalls) return;
      nextCallIndex += 1;
      let stable = false;
      const lifecycle: GeminiMediaEdgeBenchmarkCallLifecycle = Object.freeze({
        markStable(): void {
          if (stable) throw new Error(`benchmark call ${callIndex} marked stable more than once`);
          stable = true;
          stableNow += 1;
          if (stableNow > stablePeak) stablePeak = stableNow;
          if (stableNow > concurrency) throw new Error("benchmark stable connection count exceeded configured concurrency");
        },
        markUnstable(): void {
          if (!stable) throw new Error(`benchmark call ${callIndex} marked unstable without stable ownership`);
          stable = false;
          stableNow -= 1;
        },
      });

      const call: GeminiMediaEdgeBenchmarkCandidateCall = Object.freeze({
        callIndex,
        workload,
        profile: geminiMediaEdgeBenchmarkCallProfile(callIndex, workload),
        ingressTrace: () => geminiMediaEdgeBenchmarkIngressTrace(workload),
        geminiOutputTrace: () => geminiMediaEdgeBenchmarkOutputTrace(workload),
        lifecycle,
      });

      const observation = await adapter.executeCall(call);
      if (stable) throw new Error(`benchmark call ${callIndex} returned while still marked stable`);
      if (!observation || (observation.outcome !== "COMPLETED" && observation.outcome !== "FAILED")) {
        throw new Error(`benchmark call ${callIndex} returned an invalid outcome`);
      }
      if (observation.outcome === "COMPLETED") completedCalls += 1;
      else failedCalls += 1;
      append(raw.telnyxToGeminiMs, observation.telnyxToGeminiMs);
      append(raw.geminiToTelnyxMs, observation.geminiToTelnyxMs);
      append(raw.telnyxSocketEstablishmentMs, observation.telnyxSocketEstablishmentMs);
      append(raw.geminiSocketEstablishmentMs, observation.geminiSocketEstablishmentMs);
      append(raw.jitterMs, observation.jitterMs);
      append(raw.cpuPercent, observation.cpuPercent);
      append(raw.memoryMiB, observation.memoryMiB);
      reorderedFrames += nonNegativeInteger(observation.reorderedFrames, "benchmark reorderedFrames");
      droppedFrames += nonNegativeInteger(observation.droppedFrames, "benchmark droppedFrames");
      if (observation.slowPeerClosed) slowPeerClosures += 1;
      if (observation.orphanedSession) orphanedSessions += 1;
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (stableNow !== 0) throw new Error("benchmark finished with stable connections still owned");
  if (completedCalls + failedCalls !== attemptedCalls) throw new Error("benchmark candidate did not return exactly one outcome per attempted call");

  const endedEpochMs = finiteEpoch(clock.nowEpochMs(), "benchmark end time");
  if (endedEpochMs < startedEpochMs) throw new Error("benchmark clock moved backwards");
  const durationSeconds = Math.max(1, Math.ceil((endedEpochMs - startedEpochMs) / 1000));

  const rawSamples: GeminiMediaEdgeBenchmarkRawSamples = Object.freeze({
    telnyxToGeminiMs: Object.freeze(raw.telnyxToGeminiMs.slice()),
    geminiToTelnyxMs: Object.freeze(raw.geminiToTelnyxMs.slice()),
    telnyxSocketEstablishmentMs: Object.freeze(raw.telnyxSocketEstablishmentMs.slice()),
    geminiSocketEstablishmentMs: Object.freeze(raw.geminiSocketEstablishmentMs.slice()),
    jitterMs: Object.freeze(raw.jitterMs.slice()),
    cpuPercent: Object.freeze(raw.cpuPercent.slice()),
    memoryMiB: Object.freeze(raw.memoryMiB.slice()),
  });

  return buildGeminiMediaEdgeBenchmarkEvidence(workload, Object.freeze({
    candidateId,
    candidateRegion,
    referenceRegion,
    runId,
    startedAt,
    durationSeconds,
    concurrency,
    completedCalls,
    failedCalls,
    reorderedFrames,
    droppedFrames,
    stableConcurrentConnections: stablePeak,
    slowPeerClosures,
    orphanedSessions,
    estimatedCostPer1000CallMinutesUsd,
  }), rawSamples);
}
