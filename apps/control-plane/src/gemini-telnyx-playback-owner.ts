import type { AssistantSpeechKind, RealtimeProviderEvent } from "./realtime-provider-event.js";

export type GeminiTelnyxPlaybackSnapshot = Readonly<{
  responseId: string | null;
  kind: AssistantSpeechKind | null;
  started: boolean;
  pendingMark: string | null;
  pendingMarkPurpose: "DRAIN" | "CLEAR" | null;
}>;

/**
 * Correlates Gemini response identity with Telnyx playback evidence.
 *
 * Audio bytes prove playback was queued, not that the caller heard them. Telnyx
 * mark echoes are the structural playback-drain evidence. A clear operation is
 * followed by its own mark so a returned mark can be classified as CLEARED rather
 * than STOPPED without clocks, sleeps or arrival windows.
 */
export class GeminiTelnyxPlaybackOwner {
  private responseId: string | null = null;
  private kind: AssistantSpeechKind | null = null;
  private started = false;
  private pendingMark: string | null = null;
  private pendingMarkPurpose: "DRAIN" | "CLEAR" | null = null;
  private markSequence = 0;

  observeAudioQueued(responseId: string, kind: AssistantSpeechKind): RealtimeProviderEvent[] {
    const id = responseId.trim();
    if (!id) throw new Error("Gemini playback requires responseId");
    if (this.responseId && this.responseId !== id) {
      throw new Error(`Gemini playback already owned by ${this.responseId}`);
    }
    this.responseId = id;
    this.kind = kind;
    if (this.started) return [];
    this.started = true;
    return [{ type: "ASSISTANT_AUDIO_STARTED", kind, responseId: id }];
  }

  requestDrainMark(responseId: string): string {
    return this.createMark(responseId, "DRAIN");
  }

  requestClearMark(responseId: string): string {
    return this.createMark(responseId, "CLEAR");
  }

  observeReturnedMark(name: string): RealtimeProviderEvent[] {
    const normalized = name.trim();
    if (!normalized || normalized !== this.pendingMark) return [];
    if (!this.responseId || !this.kind || !this.pendingMarkPurpose) {
      throw new Error("Gemini playback mark has no active ownership");
    }
    const event: RealtimeProviderEvent = this.pendingMarkPurpose === "CLEAR"
      ? { type: "ASSISTANT_AUDIO_CLEARED", kind: this.kind, responseId: this.responseId }
      : { type: "ASSISTANT_AUDIO_STOPPED", kind: this.kind, responseId: this.responseId };
    this.release();
    return [event];
  }

  snapshot(): GeminiTelnyxPlaybackSnapshot {
    return Object.freeze({
      responseId: this.responseId,
      kind: this.kind,
      started: this.started,
      pendingMark: this.pendingMark,
      pendingMarkPurpose: this.pendingMarkPurpose,
    });
  }

  private createMark(responseId: string, purpose: "DRAIN" | "CLEAR"): string {
    const id = responseId.trim();
    if (!id || this.responseId !== id || !this.started) {
      throw new Error(`Gemini playback ${purpose.toLowerCase()} mark requires active response ${id || "<empty>"}`);
    }
    if (this.pendingMark) throw new Error(`Gemini playback already awaits mark ${this.pendingMark}`);
    this.markSequence += 1;
    this.pendingMark = `ia-gemini-playback:${purpose.toLowerCase()}:${this.markSequence}:${id}`;
    this.pendingMarkPurpose = purpose;
    return this.pendingMark;
  }

  private release(): void {
    this.responseId = null;
    this.kind = null;
    this.started = false;
    this.pendingMark = null;
    this.pendingMarkPurpose = null;
  }
}
