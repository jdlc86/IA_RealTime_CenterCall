export type ProtectedSpeechKind = "GREETING" | "RECOVERY" | "TERMINAL";

export type ProtectedSpeechSnapshot = {
  kind: ProtectedSpeechKind;
  clientEventId: string;
  responseId: string | null;
  playbackStarted: boolean;
};

export type ProtectedSpeechRelease = {
  released: boolean;
  kind?: ProtectedSpeechKind;
  reason?: string;
};

/**
 * Small deterministic lifecycle helper for speech that must remain atomic.
 * It deliberately contains no semantic interpretation: it only correlates
 * Realtime response/playback events with one protected response at a time.
 */
export class ProtectedSpeechLifecycle {
  private active: ProtectedSpeechSnapshot | null = null;

  begin(kind: ProtectedSpeechKind, clientEventId: string): boolean {
    if (this.active) return false;
    if (!clientEventId.trim()) throw new Error("protected speech clientEventId is required");
    this.active = { kind, clientEventId, responseId: null, playbackStarted: false };
    return true;
  }

  isActive(): boolean {
    return this.active !== null;
  }

  snapshot(): ProtectedSpeechSnapshot | null {
    return this.active ? { ...this.active } : null;
  }

  bindResponse(responseId: string): boolean {
    if (!this.active || !responseId.trim()) return false;
    if (this.active.responseId && this.active.responseId !== responseId) return false;
    this.active.responseId = responseId;
    return true;
  }

  markPlaybackStarted(responseId: string | null | undefined): boolean {
    if (!this.matchesResponse(responseId)) return false;
    this.active!.playbackStarted = true;
    return true;
  }

  onPlaybackStopped(responseId: string | null | undefined): ProtectedSpeechRelease {
    if (!this.matchesResponse(responseId)) return { released: false };
    return this.release("output_audio_buffer_stopped");
  }

  onPlaybackCleared(responseId: string | null | undefined): ProtectedSpeechRelease {
    if (!this.matchesResponse(responseId)) return { released: false };
    return this.release("output_audio_buffer_cleared");
  }

  onResponseDone(responseId: string | null | undefined, status: string | null | undefined): ProtectedSpeechRelease {
    if (!this.matchesResponse(responseId)) return { released: false };

    // A completed response may still have audio queued in SIP playback. Even a
    // non-completed response may have already produced buffered audio. In both
    // cases keep protection until the buffer explicitly stops/clears.
    if (status === "completed" || this.active!.playbackStarted) return { released: false };

    return this.release(`response_done_${status || "unknown"}`);
  }

  onClientError(eventId: string | null | undefined): ProtectedSpeechRelease {
    if (!this.active || !eventId || eventId !== this.active.clientEventId) return { released: false };
    if (this.active.playbackStarted) return { released: false };
    return this.release("response_create_error");
  }

  forceRelease(reason: string): ProtectedSpeechRelease {
    if (!this.active) return { released: false };
    return this.release(reason);
  }

  private matchesResponse(responseId: string | null | undefined): boolean {
    return Boolean(this.active?.responseId && responseId && this.active.responseId === responseId);
  }

  private release(reason: string): ProtectedSpeechRelease {
    const current = this.active;
    if (!current) return { released: false };
    this.active = null;
    return { released: true, kind: current.kind, reason };
  }
}
