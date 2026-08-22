export type ProtectedSpeechKind = "GREETING" | "RECOVERY";

export type ProtectedSpeechSnapshot = {
  kind: ProtectedSpeechKind;
  clientEventId: string;
  responseId: string | null;
  playbackStarted: boolean;
  responseCompleted: boolean;
  replayPending: boolean;
  replayCount: number;
};

export type ProtectedSpeechRelease = {
  released: boolean;
  replayRequested?: boolean;
  kind?: ProtectedSpeechKind;
  reason?: string;
};

const DEFAULT_MAX_REPLAYS = 2;

/**
 * Small deterministic lifecycle helper for speech that must remain atomic.
 * It deliberately contains no semantic interpretation: it only correlates
 * Realtime response/playback events with one protected response at a time.
 */
export class ProtectedSpeechLifecycle {
  private active: ProtectedSpeechSnapshot | null = null;

  constructor(private readonly maxReplays = DEFAULT_MAX_REPLAYS) {
    if (!Number.isInteger(maxReplays) || maxReplays < 0) {
      throw new Error("protected speech maxReplays must be a non-negative integer");
    }
  }

  begin(kind: ProtectedSpeechKind, clientEventId: string): boolean {
    if (this.active) return false;
    if (!clientEventId.trim()) throw new Error("protected speech clientEventId is required");
    this.active = {
      kind,
      clientEventId,
      responseId: null,
      playbackStarted: false,
      responseCompleted: false,
      replayPending: false,
      replayCount: 0,
    };
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
    this.active!.playbackStarted = false;
    this.active!.replayPending = true;
    return this.active!.responseCompleted
      ? this.requestReplay()
      : { released: false };
  }

  onResponseDone(responseId: string | null | undefined, status: string | null | undefined): ProtectedSpeechRelease {
    if (!this.matchesResponse(responseId)) return { released: false };

    this.active!.responseCompleted = true;
    if (this.active!.replayPending) return this.requestReplay();

    // A completed response may still have audio queued in SIP playback. Even a
    // non-completed response may have already produced buffered audio. In both
    // cases keep protection until the buffer explicitly stops/clears.
    if (status === "completed" || this.active!.playbackStarted) return { released: false };

    return this.release(`response_done_${status || "unknown"}`);
  }

  prepareReplay(clientEventId: string): boolean {
    if (!this.active?.replayPending) return false;
    if (!clientEventId.trim()) throw new Error("protected speech replay clientEventId is required");
    if (this.active.replayCount >= this.maxReplays) return false;
    this.active.clientEventId = clientEventId;
    this.active.responseId = null;
    this.active.playbackStarted = false;
    this.active.responseCompleted = false;
    this.active.replayPending = false;
    this.active.replayCount += 1;
    return true;
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

  private requestReplay(): ProtectedSpeechRelease {
    const current = this.active;
    if (!current) return { released: false };
    if (current.replayCount >= this.maxReplays) {
      return this.release("output_audio_buffer_cleared_replay_exhausted");
    }
    return {
      released: false,
      replayRequested: true,
      kind: current.kind,
      reason: "output_audio_buffer_cleared",
    };
  }
}
