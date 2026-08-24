function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

/**
 * Tracks the product-owned governed-speech reservation independently from the
 * physical playback owner. This prevents Gemini Live audio from being attributed
 * to a governed response while TTS is pending or that response is playing.
 */
export class GovernedSpeechPlaybackCoordinator {
  constructor() {
    this.pendingResponseId = null;
    this.activeResponseId = null;
  }

  reserve(responseId) {
    const id = required(responseId, "Governed speech response id");
    if (this.pendingResponseId || this.activeResponseId) {
      throw new Error(`Governed speech already owns ${this.pendingResponseId ?? this.activeResponseId}`);
    }
    this.pendingResponseId = id;
    return this.snapshot();
  }

  beginPlayback(responseId) {
    const id = required(responseId, "Governed speech response id");
    if (this.pendingResponseId !== id) {
      throw new Error(`Governed speech pending identity mismatch: expected ${this.pendingResponseId ?? "<none>"}`);
    }
    this.pendingResponseId = null;
    this.activeResponseId = id;
    return this.snapshot();
  }

  assertProviderAudioAllowed() {
    if (this.pendingResponseId || this.activeResponseId) {
      throw new Error("Gemini Live audio is forbidden while governed speech owns playback");
    }
  }

  observePlaybackEvent(event) {
    if (!event || (event.type !== "ASSISTANT_AUDIO_STOPPED" && event.type !== "ASSISTANT_AUDIO_CLEARED")) return false;
    if (!this.activeResponseId) return false;
    const responseId = required(event.responseId, "Governed speech playback event response id");
    if (responseId !== this.activeResponseId) {
      throw new Error(`Governed speech playback identity mismatch: expected ${this.activeResponseId}`);
    }
    this.activeResponseId = null;
    return true;
  }

  reset() {
    this.pendingResponseId = null;
    this.activeResponseId = null;
  }

  snapshot() {
    return Object.freeze({ pendingResponseId: this.pendingResponseId, activeResponseId: this.activeResponseId });
  }
}
