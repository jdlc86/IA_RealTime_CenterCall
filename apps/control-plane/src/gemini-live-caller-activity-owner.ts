import type { RealtimeProviderEvent } from "./realtime-provider-event.js";

export type GeminiCallerActivitySnapshot = Readonly<{
  activeItemId: string | null;
  sequence: number;
}>;

/**
 * Provider-edge owner for caller acoustic activity identity.
 *
 * Gemini Live does not supply the OpenAI conversation item identity expected by
 * the neutral barge-in/order pipeline. When manual activity detection is used,
 * the media edge owns activityStart/activityEnd and therefore also owns a stable
 * neutral item id for that acoustic turn. This owner emits only speech boundaries;
 * transcript completion remains a separate evidence problem.
 */
export class GeminiLiveCallerActivityOwner {
  private activeItemId: string | null = null;
  private sequence = 0;

  begin(): { event: RealtimeProviderEvent; snapshot: GeminiCallerActivitySnapshot } {
    if (this.activeItemId) {
      throw new Error(`Gemini caller activity already active: ${this.activeItemId}`);
    }
    this.sequence += 1;
    this.activeItemId = `gemini-caller-${this.sequence}`;
    return {
      event: { type: "CALLER_SPEECH_STARTED", itemId: this.activeItemId },
      snapshot: this.snapshot(),
    };
  }

  end(): { event: RealtimeProviderEvent; itemId: string; snapshot: GeminiCallerActivitySnapshot } {
    const itemId = this.activeItemId;
    if (!itemId) throw new Error("Gemini caller activity cannot end without an active item");
    this.activeItemId = null;
    return {
      event: { type: "CALLER_SPEECH_STOPPED" },
      itemId,
      snapshot: this.snapshot(),
    };
  }

  active(): string | null { return this.activeItemId; }

  snapshot(): GeminiCallerActivitySnapshot {
    return Object.freeze({ activeItemId: this.activeItemId, sequence: this.sequence });
  }
}
