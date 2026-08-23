import type { GeminiLiveCommandHost } from "./gemini-live-command-adapter.js";
import {
  geminiPcm24kPayloadToTelnyxMedia,
  telnyxL16PayloadToGeminiRealtimeInput,
} from "./gemini-telnyx-media-contract.js";
import { Pcm16LinearResampler24To16 } from "./pcm16-stream-resampler.js";
import {
  TelnyxGeminiMediaStreamOwner,
  type TelnyxGeminiMediaObservation,
} from "./telnyx-gemini-media-stream-owner.js";

export type TelnyxMediaCommandHost = {
  send(message: Record<string, unknown>): void;
};

export type GeminiTelnyxMediaBridgeSnapshot = Readonly<{
  state: "ACTIVE" | "FAILED" | "STOPPED";
  inboundChunksForwarded: number;
  outboundChunksForwarded: number;
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

function outputAudioPayloads(data: unknown): string[] {
  const message = readJson(data);
  if (!message) return [];
  const parts = message.serverContent?.modelTurn?.parts ?? message.server_content?.model_turn?.parts ?? [];
  const payloads: string[] = [];
  for (const part of parts) {
    const inline = part.inlineData ?? part.inline_data;
    const payload = inline?.data;
    const mime = inline && "mimeType" in inline ? inline.mimeType : inline?.mime_type;
    if (typeof payload === "string" && payload && typeof mime === "string" && /^audio\/pcm(?:;|$)/i.test(mime)) {
      payloads.push(payload);
    }
  }
  return payloads;
}

/**
 * Isolated G3 media composition. This component owns only telephony/provider audio
 * framing and ordering; it owns no conversation, tool or provider-selection state.
 * Provider affinity is fixed before this bridge is constructed and there is no
 * cross-provider fallback path.
 */
export class GeminiTelnyxMediaBridge {
  private readonly telnyxOwner = new TelnyxGeminiMediaStreamOwner();
  private readonly outputResampler = new Pcm16LinearResampler24To16();
  private state: GeminiTelnyxMediaBridgeSnapshot["state"] = "ACTIVE";
  private inboundChunksForwarded = 0;
  private outboundChunksForwarded = 0;

  constructor(
    private readonly geminiHost: GeminiLiveCommandHost,
    private readonly telnyxHost: TelnyxMediaCommandHost,
  ) {}

  observeTelnyx(data: unknown): TelnyxGeminiMediaObservation {
    this.assertActive();
    let observation: TelnyxGeminiMediaObservation;
    try {
      observation = this.telnyxOwner.observe(data);
      for (const payload of observation.mediaPayloads) {
        this.geminiHost.send(telnyxL16PayloadToGeminiRealtimeInput(payload));
        this.inboundChunksForwarded += 1;
      }
      if (observation.stopped) this.state = "STOPPED";
      return observation;
    } catch (error) {
      this.state = "FAILED";
      throw error;
    }
  }

  observeGemini(data: unknown): number {
    this.assertActive();
    try {
      let emitted = 0;
      for (const payload of outputAudioPayloads(data)) {
        const media = geminiPcm24kPayloadToTelnyxMedia(payload, this.outputResampler);
        if (!media) continue;
        this.telnyxHost.send(media);
        this.outboundChunksForwarded += 1;
        emitted += 1;
      }
      return emitted;
    } catch (error) {
      this.state = "FAILED";
      throw error;
    }
  }

  clearPlayback(): void {
    this.assertActive();
    try {
      this.telnyxHost.send({ event: "clear" });
      this.outputResampler.reset();
    } catch (error) {
      this.state = "FAILED";
      throw error;
    }
  }

  sendPlaybackMark(name: string): void {
    this.assertActive();
    const normalized = name.trim();
    if (!normalized) throw new Error("Telnyx playback mark requires a name");
    try {
      this.telnyxHost.send({ event: "mark", mark: { name: normalized } });
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
