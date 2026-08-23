import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import type { AuthoritativeCallerTranscriptionPort } from "./authoritative-caller-transcription-port.js";
import {
  GeminiDeferredBargeInTranscriptionRuntime,
  type GeminiDeferredBargeInTranscriptionSnapshot,
} from "./gemini-deferred-barge-in-transcription-runtime.js";
import {
  GeminiTelnyxAcousticVad,
  type GeminiTelnyxAcousticVadConfig,
  type GeminiTelnyxAcousticVadSnapshot,
} from "./gemini-telnyx-acoustic-vad.js";

export type GeminiDeferredBargeInAcousticSnapshot = Readonly<{
  vad: GeminiTelnyxAcousticVadSnapshot;
  transcription: GeminiDeferredBargeInTranscriptionSnapshot;
}>;

export type GeminiDeferredBargeInAcousticObservation = Readonly<{
  events: readonly RealtimeProviderEvent[];
  snapshot: GeminiDeferredBargeInAcousticSnapshot;
}>;

/**
 * Edge composition for caller acoustic boundaries and authoritative transcription.
 *
 * Telnyx media is first classified by the sample-count VAD. The first neutral
 * CALLER_SPEECH_STARTED event is emitted only after acoustic onset is proven; every
 * onset payload retained by the VAD is replayed exactly once into the deferred
 * candidate. SPEECH_END buffers the terminating payload, performs authoritative STT
 * over the exact candidate audio, then emits CALLER_SPEECH_STOPPED and
 * CALLER_TRANSCRIPT_COMPLETED. No Gemini Live transcription evidence participates.
 */
export class GeminiDeferredBargeInAcousticRuntime {
  private readonly vad: GeminiTelnyxAcousticVad;
  private readonly transcription: GeminiDeferredBargeInTranscriptionRuntime;

  constructor(
    transcription: AuthoritativeCallerTranscriptionPort,
    vadConfig: GeminiTelnyxAcousticVadConfig,
    options: Readonly<{ maxBufferedChunks?: number; maxBufferedPayloadChars?: number }> = {},
  ) {
    this.vad = new GeminiTelnyxAcousticVad(vadConfig);
    this.transcription = new GeminiDeferredBargeInTranscriptionRuntime(transcription, options);
  }

  async observeTelnyxMedia(payload: string): Promise<GeminiDeferredBargeInAcousticObservation> {
    const acoustic = this.vad.observe(payload);
    const events: RealtimeProviderEvent[] = [];

    if (acoustic.boundary?.type === "SPEECH_START") {
      const started = this.transcription.beginCandidate();
      events.push(started);
      for (const replayPayload of acoustic.boundary.replayPayloads) {
        this.transcription.bufferTelnyxMedia(replayPayload);
      }
    } else if (acoustic.shouldBufferPayload && this.transcription.snapshot().candidate.activeItemId) {
      this.transcription.bufferTelnyxMedia(payload);
    }

    if (acoustic.boundary?.type === "SPEECH_END") {
      const itemId = this.transcription.snapshot().candidate.activeItemId;
      if (!itemId) throw new Error("Gemini acoustic speech end has no active deferred candidate");
      try {
        events.push(...await this.transcription.completeAuthoritativeTranscript());
      } catch (error) {
        if (this.transcription.snapshot().candidate.activeItemId === itemId) {
          this.transcription.ignoreCandidate(itemId);
        }
        throw error;
      }
    }

    return Object.freeze({
      events: Object.freeze(events),
      snapshot: this.snapshot(),
    });
  }

  confirmInterruption(itemId: string) {
    return this.transcription.confirmInterruption(itemId);
  }

  ignoreCandidate(itemId: string): GeminiDeferredBargeInAcousticSnapshot {
    this.transcription.ignoreCandidate(itemId);
    this.vad.reset();
    return this.snapshot();
  }

  snapshot(): GeminiDeferredBargeInAcousticSnapshot {
    return Object.freeze({
      vad: this.vad.snapshot(),
      transcription: this.transcription.snapshot(),
    });
  }
}
