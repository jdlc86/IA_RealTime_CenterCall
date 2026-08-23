import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import {
  requireAuthoritativeCallerTranscriptEvidence,
  type AuthoritativeCallerTranscriptionRequest,
} from "./authoritative-caller-transcription-port.js";

export type GeminiDeferredBargeInCandidate = Readonly<{
  itemId: string;
  transcript: string;
  mediaPayloads: readonly string[];
}>;

export type GeminiDeferredBargeInCandidateSnapshot = Readonly<{
  activeItemId: string | null;
  sequence: number;
  bufferedChunks: number;
  bufferedPayloadChars: number;
  transcriptReady: boolean;
}>;

type ActiveCandidate = {
  itemId: string;
  mediaPayloads: string[];
  bufferedPayloadChars: number;
  transcript: string | null;
};

const CONFIRMED_CANDIDATES = new WeakSet<object>();

/**
 * Runtime authorization check used by the later provider commit adapter.
 * Shape-compatible objects are not sufficient: only confirmInterruption() can
 * register a candidate in this module-scoped capability set.
 */
export function requireConfirmedGeminiDeferredBargeInCandidate(
  value: unknown,
): GeminiDeferredBargeInCandidate {
  if (!value || typeof value !== "object" || !CONFIRMED_CANDIDATES.has(value)) {
    throw new Error("Gemini deferred barge-in candidate is not semantically authorized");
  }
  return value as GeminiDeferredBargeInCandidate;
}

/**
 * Owns a caller acoustic candidate while an assistant response is still protected
 * by the semantic barge-in gate.
 *
 * This owner deliberately has no Gemini command host. Starting an acoustic
 * candidate therefore cannot send activityStart, audio or clientContent to Gemini
 * and cannot interrupt the active model response before semantic authorization.
 *
 * A separate authoritative transcription boundary may complete the candidate.
 * The STT request is minted from this owner's exact buffered Telnyx PCM16
 * big-endian payloads and the returned evidence must carry those same payloads
 * before transcript completion is accepted. Only after the core confirms
 * interruption may the returned immutable candidate be committed to a
 * provider-specific interrupting activity transport. Ignored candidates are
 * discarded without provider side effects. No timers or arrival windows are used.
 */
export class GeminiDeferredBargeInCandidateOwner {
  private sequence = 0;
  private active: ActiveCandidate | null = null;

  constructor(
    private readonly maxBufferedChunks = 256,
    private readonly maxBufferedPayloadChars = 2_000_000,
  ) {
    if (!Number.isInteger(maxBufferedChunks) || maxBufferedChunks < 1) {
      throw new Error("Gemini deferred candidate maxBufferedChunks must be a positive integer");
    }
    if (!Number.isInteger(maxBufferedPayloadChars) || maxBufferedPayloadChars < 1) {
      throw new Error("Gemini deferred candidate maxBufferedPayloadChars must be a positive integer");
    }
  }

  beginCandidate(): Extract<RealtimeProviderEvent, { type: "CALLER_SPEECH_STARTED" }> {
    if (this.active) {
      throw new Error(`Gemini deferred candidate already active: ${this.active.itemId}`);
    }
    this.sequence += 1;
    const itemId = `gemini-candidate-${this.sequence}`;
    this.active = {
      itemId,
      mediaPayloads: [],
      bufferedPayloadChars: 0,
      transcript: null,
    };
    return { type: "CALLER_SPEECH_STARTED", itemId };
  }

  bufferTelnyxMedia(payload: string): GeminiDeferredBargeInCandidateSnapshot {
    const active = this.requireActive();
    if (active.transcript !== null) {
      throw new Error(`Gemini deferred candidate ${active.itemId} is already completed`);
    }
    const normalized = payload.trim();
    if (!normalized) throw new Error("Gemini deferred candidate media payload is required");
    if (active.mediaPayloads.length >= this.maxBufferedChunks) {
      throw new Error(`Gemini deferred candidate ${active.itemId} exceeded buffered chunk limit`);
    }
    const nextChars = active.bufferedPayloadChars + normalized.length;
    if (nextChars > this.maxBufferedPayloadChars) {
      throw new Error(`Gemini deferred candidate ${active.itemId} exceeded buffered payload limit`);
    }
    active.mediaPayloads.push(normalized);
    active.bufferedPayloadChars = nextChars;
    return this.snapshot();
  }

  transcriptionRequest(): AuthoritativeCallerTranscriptionRequest {
    const active = this.requireActive();
    if (active.transcript !== null) {
      throw new Error(`Gemini deferred candidate ${active.itemId} is already completed`);
    }
    if (active.mediaPayloads.length === 0) {
      throw new Error(`Gemini deferred candidate ${active.itemId} cannot transcribe without buffered audio`);
    }
    return Object.freeze({
      itemId: active.itemId,
      audio: Object.freeze({
        encoding: "PCM16_BE" as const,
        sampleRateHz: 16_000 as const,
        channels: 1 as const,
        payloads: Object.freeze([...active.mediaPayloads]),
      }),
    });
  }

  completeCandidate(value: unknown): readonly RealtimeProviderEvent[] {
    const active = this.requireActive();
    if (active.transcript !== null) {
      throw new Error(`Gemini deferred candidate ${active.itemId} is already completed`);
    }
    const evidence = requireAuthoritativeCallerTranscriptEvidence(value);
    if (evidence.itemId !== active.itemId) {
      throw new Error(`Gemini deferred candidate transcript identity mismatch: expected ${active.itemId}`);
    }
    if (
      evidence.audio.encoding !== "PCM16_BE"
      || evidence.audio.sampleRateHz !== 16_000
      || evidence.audio.channels !== 1
      || evidence.audio.payloads.length !== active.mediaPayloads.length
      || evidence.audio.payloads.some((payload, index) => payload !== active.mediaPayloads[index])
    ) {
      throw new Error(`Gemini deferred candidate transcript audio mismatch: ${active.itemId}`);
    }
    active.transcript = evidence.transcript;
    return Object.freeze([
      { type: "CALLER_SPEECH_STOPPED" } as const,
      { type: "CALLER_TRANSCRIPT_COMPLETED", transcript: evidence.transcript, itemId: active.itemId } as const,
    ]);
  }

  confirmInterruption(itemId: string): GeminiDeferredBargeInCandidate {
    const active = this.requireMatching(itemId);
    if (active.transcript === null) {
      throw new Error(`Gemini deferred candidate ${active.itemId} cannot commit before transcript completion`);
    }
    const committed = Object.freeze({
      itemId: active.itemId,
      transcript: active.transcript,
      mediaPayloads: Object.freeze([...active.mediaPayloads]),
    });
    CONFIRMED_CANDIDATES.add(committed);
    this.active = null;
    return committed;
  }

  ignoreCandidate(itemId: string): GeminiDeferredBargeInCandidateSnapshot {
    this.requireMatching(itemId);
    this.active = null;
    return this.snapshot();
  }

  snapshot(): GeminiDeferredBargeInCandidateSnapshot {
    return Object.freeze({
      activeItemId: this.active?.itemId ?? null,
      sequence: this.sequence,
      bufferedChunks: this.active?.mediaPayloads.length ?? 0,
      bufferedPayloadChars: this.active?.bufferedPayloadChars ?? 0,
      transcriptReady: this.active?.transcript !== null && this.active !== null,
    });
  }

  private requireActive(): ActiveCandidate {
    if (!this.active) throw new Error("Gemini deferred candidate is not active");
    return this.active;
  }

  private requireMatching(itemId: string): ActiveCandidate {
    const active = this.requireActive();
    const normalized = itemId.trim();
    if (!normalized || normalized !== active.itemId) {
      throw new Error(`Gemini deferred candidate identity mismatch: expected ${active.itemId}`);
    }
    return active;
  }
}
