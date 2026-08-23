import type { GeminiLiveCommandHost } from "./gemini-live-command-adapter.js";
import type { AssistantSpeechKind, RealtimeProviderEvent } from "./realtime-provider-event.js";
import {
  geminiPcm24kPayloadToTelnyxMedia,
  telnyxL16PayloadToGeminiRealtimeInput,
} from "./gemini-telnyx-media-contract.js";
import { GeminiTelnyxPlaybackOwner } from "./gemini-telnyx-playback-owner.js";
import { Pcm16LinearResampler24To16 } from "./pcm16-stream-resampler.js";
import {
  TelnyxGeminiMediaStreamOwner,
  type TelnyxGeminiMediaObservation,
} from "./telnyx-gemini-media-stream-owner.js";

export type TelnyxMediaCommandHost = {
  send(message: Record<string, unknown>): void;
};

export type GeminiTelnyxInboundAudioMode = "FORWARD" | "DEFER";

export type GeminiTelnyxMediaBridgeSnapshot = Readonly<{
  state: "ACTIVE" | "FAILED" | "STOPPED";
  inboundChunksForwarded: number;
  outboundChunksForwarded: number;
}>;

export type GeminiTelnyxInboundObservation = Readonly<{
  telnyx: TelnyxGeminiMediaObservation;
  playbackEvents: readonly RealtimeProviderEvent[];
}>;

export type GeminiTelnyxOutboundObservation = Readonly<{
  emitted: number;
  playbackEvents: readonly RealtimeProviderEvent[];
}>;

type GeminiInlinePart = {
  inlineData?: { data?: unknown; mimeType?: unknown };
  inline_data?: { data?: unknown; mime_type?: unknown };
};

type GeminiMediaMessage = {
  serverContent?: { modelTurn?: { parts?: GeminiInlinePart[] } };
  server_content?: { model_turn?: { parts?: GeminiInlinePart[] } };
};

function readJson(data: unknown): GeminiMediaMessage | null {
  let value = data;
  if (typeof data === "string") {
    try { value = JSON.parse(data); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as GeminiMediaMessage;
}

function readInlineAudio(part: GeminiInlinePart): { data: unknown; mime: unknown } | null {
  if (part.inlineData) return { data: part.inlineData.data, mime: part.inlineData.mimeType };
  if (part.inline_data) return { data: part.inline_data.data, mime: part.inline_data.mime_type };
  return null;
}

function outputAudioPayloads(data: unknown): string[] {
  const message = readJson(data);
  if (!message) return [];
  const parts = message.serverContent?.modelTurn?.parts ?? message.server_content?.model_turn?.parts ?? [];
  const payloads: string[] = [];
  for (const part of parts) {
    const inline = readInlineAudio(part);
    if (!inline) continue;
    if (typeof inline.data === "string" && inline.data && typeof inline.mime === "string" && /^audio\/pcm(?:;|$)/i.test(inline.mime)) {
      payloads.push(inline.data);
    }
  }
  return payloads;
}

/**
 * Isolated G3/G4 media composition. This component owns telephony/provider audio
 * framing, ordering and playback evidence only. It owns no conversation, tool or
 * provider-selection state. Provider affinity and inbound forwarding mode are fixed
 * before construction and there is no cross-provider fallback path.
 *
 * FORWARD preserves the original media path. DEFER keeps ordered Telnyx payloads in
 * the returned observation without writing them to Gemini; a higher edge authority
 * can then perform VAD/STT/semantic authorization before any provider commit.
 */
export class GeminiTelnyxMediaBridge {
  private readonly telnyxOwner = new TelnyxGeminiMediaStreamOwner();
  private readonly playbackOwner = new GeminiTelnyxPlaybackOwner();
  private readonly outputResampler = new Pcm16LinearResampler24To16();
  private state: GeminiTelnyxMediaBridgeSnapshot["state"] = "ACTIVE";
  private inboundChunksForwarded = 0;
  private outboundChunksForwarded = 0;

  constructor(
    private readonly geminiHost: GeminiLiveCommandHost,
    private readonly telnyxHost: TelnyxMediaCommandHost,
    private readonly inboundAudioMode: GeminiTelnyxInboundAudioMode = "FORWARD",
  ) {
    if (inboundAudioMode !== "FORWARD" && inboundAudioMode !== "DEFER") {
      throw new Error(`Gemini Telnyx media bridge invalid inbound audio mode: ${String(inboundAudioMode)}`);
    }
  }

  observeTelnyx(data: unknown): GeminiTelnyxInboundObservation {
    this.assertActive();
    try {
      const observation = this.telnyxOwner.observe(data);
      const playbackEvents: RealtimeProviderEvent[] = [];
      if (this.inboundAudioMode === "FORWARD") {
        for (const payload of observation.mediaPayloads) {
          this.geminiHost.send(telnyxL16PayloadToGeminiRealtimeInput(payload));
          this.inboundChunksForwarded += 1;
        }
      }
      for (const mark of observation.returnedMarks) {
        playbackEvents.push(...this.playbackOwner.observeReturnedMark(mark));
      }
      if (observation.stopped) this.state = "STOPPED";
      return Object.freeze({
        telnyx: observation,
        playbackEvents: Object.freeze(playbackEvents),
      });
    } catch (error) {
      this.state = "FAILED";
      throw error;
    }
  }

  observeGemini(
    data: unknown,
    responseId: string | null,
    kind: AssistantSpeechKind = "NORMAL",
  ): GeminiTelnyxOutboundObservation {
    this.assertActive();
    try {
      let emitted = 0;
      const playbackEvents: RealtimeProviderEvent[] = [];
      const payloads = outputAudioPayloads(data);
      if (payloads.length > 0 && !responseId?.trim()) {
        throw new Error("Gemini output audio requires correlated responseId");
      }
      for (const payload of payloads) {
        const media = geminiPcm24kPayloadToTelnyxMedia(payload, this.outputResampler);
        if (!media) continue;
        this.telnyxHost.send(media);
        this.outboundChunksForwarded += 1;
        emitted += 1;
        playbackEvents.push(...this.playbackOwner.observeAudioQueued(responseId!, kind));
      }
      return Object.freeze({ emitted, playbackEvents: Object.freeze(playbackEvents) });
    } catch (error) {
      this.state = "FAILED";
      throw error;
    }
  }

  activePlaybackResponseId(): string | null {
    return this.playbackOwner.snapshot().responseId;
  }

  finishPlayback(responseId: string): string | null {
    this.assertActive();
    if (this.playbackOwner.snapshot().responseId !== responseId) return null;
    const mark = this.playbackOwner.requestDrainMark(responseId);
    try {
      this.telnyxHost.send({ event: "mark", mark: { name: mark } });
      return mark;
    } catch (error) {
      this.state = "FAILED";
      throw error;
    }
  }

  clearPlayback(responseId: string): string | null {
    this.assertActive();
    if (this.playbackOwner.snapshot().responseId !== responseId) return null;
    const mark = this.playbackOwner.requestClearMark(responseId);
    try {
      this.telnyxHost.send({ event: "clear" });
      this.telnyxHost.send({ event: "mark", mark: { name: mark } });
      this.outputResampler.reset();
      return mark;
    } catch (error) {
      this.state = "FAILED";
      throw error;
    }
  }

  snapshot(): GeminiTelnyxMediaBridgeSnapshot {
    return Object.freeze({
      state: this.state,
      inboundChunksForwarded: this.inboundChunksForwarded,
      outboundChunksForwarded: this.outboundChunksForwarded,
    });
  }

  private assertActive(): void {
    if (this.state !== "ACTIVE") throw new Error(`Gemini Telnyx media bridge is ${this.state.toLowerCase()}`);
  }
}
