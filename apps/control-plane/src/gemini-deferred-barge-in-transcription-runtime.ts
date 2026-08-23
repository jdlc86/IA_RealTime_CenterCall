import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import type { AuthoritativeCallerTranscriptionPort } from "./authoritative-caller-transcription-port.js";
import {
  GeminiDeferredBargeInCandidateOwner,
  type GeminiDeferredBargeInCandidate,
  type GeminiDeferredBargeInCandidateSnapshot,
} from "./gemini-deferred-barge-in-candidate-owner.js";

export type GeminiDeferredBargeInTranscriptionSnapshot = Readonly<{
  candidate: GeminiDeferredBargeInCandidateSnapshot;
  transcriptionInFlightItemId: string | null;
}>;

/**
 * Single composition authority for deferred caller audio and authoritative STT.
 *
 * No caller transcript completion can be emitted by this runtime without passing
 * through the injected AuthoritativeCallerTranscriptionPort and the candidate
 * owner's exact audio-evidence checks. Gemini Live transcription chunks are not an
 * input to this component. Concurrent duplicate transcription requests are rejected
 * structurally rather than reconciled with timers or arrival order.
 */
export class GeminiDeferredBargeInTranscriptionRuntime {
  private readonly owner: GeminiDeferredBargeInCandidateOwner;
  private transcriptionInFlightItemId: string | null = null;

  constructor(
    private readonly transcription: AuthoritativeCallerTranscriptionPort,
    options: Readonly<{ maxBufferedChunks?: number; maxBufferedPayloadChars?: number }> = {},
  ) {
    this.owner = new GeminiDeferredBargeInCandidateOwner(
      options.maxBufferedChunks,
      options.maxBufferedPayloadChars,
    );
  }

  beginCandidate(): Extract<RealtimeProviderEvent, { type: "CALLER_SPEECH_STARTED" }> {
    return this.owner.beginCandidate();
  }

  bufferTelnyxMedia(payload: string): GeminiDeferredBargeInTranscriptionSnapshot {
    this.owner.bufferTelnyxMedia(payload);
    return this.snapshot();
  }

  async completeAuthoritativeTranscript(): Promise<readonly RealtimeProviderEvent[]> {
    if (this.transcriptionInFlightItemId) {
      throw new Error(`Gemini deferred transcription already in flight: ${this.transcriptionInFlightItemId}`);
    }
    const request = this.owner.transcriptionRequest();
    this.transcriptionInFlightItemId = request.itemId;
    try {
      const evidence = await this.transcription.transcribe(request);
      if (this.owner.snapshot().activeItemId !== request.itemId) {
        throw new Error(`Gemini deferred transcription became stale: ${request.itemId}`);
      }
      return this.owner.completeCandidate(evidence);
    } finally {
      this.transcriptionInFlightItemId = null;
    }
  }

  confirmInterruption(itemId: string): GeminiDeferredBargeInCandidate {
    if (this.transcriptionInFlightItemId) {
      throw new Error(`Gemini deferred candidate cannot commit while transcription is in flight: ${this.transcriptionInFlightItemId}`);
    }
    return this.owner.confirmInterruption(itemId);
  }

  ignoreCandidate(itemId: string): GeminiDeferredBargeInTranscriptionSnapshot {
    if (this.transcriptionInFlightItemId) {
      throw new Error(`Gemini deferred candidate cannot be ignored while transcription is in flight: ${this.transcriptionInFlightItemId}`);
    }
    this.owner.ignoreCandidate(itemId);
    return this.snapshot();
  }

  snapshot(): GeminiDeferredBargeInTranscriptionSnapshot {
    return Object.freeze({
      candidate: this.owner.snapshot(),
      transcriptionInFlightItemId: this.transcriptionInFlightItemId,
    });
  }
}
