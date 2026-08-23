function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

/** Single media-edge authority for one correlated Telnyx playback at a time. */
export class TelnyxPlaybackOwner {
  constructor() { this.responseId = null; this.started = false; this.pendingMark = null; this.pendingPurpose = null; this.sequence = 0; }

  bindResponse(responseId) {
    const id = required(responseId, "Gemini playback response id");
    if (this.responseId && this.responseId !== id) throw new Error(`Gemini playback already owned by ${this.responseId}`);
    this.responseId = id;
    return this.snapshot();
  }

  noteAudioQueued(responseId) {
    const id = required(responseId, "Gemini playback response id");
    if (this.responseId !== id) throw new Error(`Gemini playback response identity mismatch: expected ${this.responseId ?? "<none>"}`);
    const first = !this.started;
    this.started = true;
    return Object.freeze({ first, snapshot: this.snapshot() });
  }

  requestDrainMark(responseId) { return this.createMark(responseId, "DRAIN"); }
  requestClearMark(responseId) { return this.createMark(responseId, "CLEAR"); }

  observeReturnedMark(name) {
    const normalized = required(name, "Telnyx playback returned mark");
    if (normalized !== this.pendingMark) return null;
    if (!this.responseId || !this.pendingPurpose) throw new Error("Telnyx playback mark has no active ownership");
    const event = Object.freeze({
      type: this.pendingPurpose === "CLEAR" ? "ASSISTANT_AUDIO_CLEARED" : "ASSISTANT_AUDIO_STOPPED",
      responseId: this.responseId,
    });
    this.release();
    return event;
  }

  activeResponseId() { return this.responseId; }
  snapshot() { return Object.freeze({ responseId: this.responseId, started: this.started, pendingMark: this.pendingMark, pendingPurpose: this.pendingPurpose }); }

  createMark(responseId, purpose) {
    const id = required(responseId, "Gemini playback response id");
    if (this.responseId !== id || !this.started) throw new Error(`Gemini playback ${purpose.toLowerCase()} mark requires active response ${id}`);
    if (this.pendingMark) throw new Error(`Gemini playback already awaits mark ${this.pendingMark}`);
    this.sequence += 1;
    this.pendingMark = `ia-gemini-playback:${purpose.toLowerCase()}:${this.sequence}:${id}`;
    this.pendingPurpose = purpose;
    return this.pendingMark;
  }

  release() { this.responseId = null; this.started = false; this.pendingMark = null; this.pendingPurpose = null; }
}
