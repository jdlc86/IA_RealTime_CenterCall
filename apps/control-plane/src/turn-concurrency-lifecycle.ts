export function isUsableCompletedTranscript(transcript: unknown): boolean {
  return typeof transcript === "string" && transcript.trim().length > 0;
}

export class TurnConcurrencyLifecycle {
  private active = false;
  private acquiredAt = 0;

  acquire(now = Date.now()): boolean {
    if (this.active) return false;
    this.active = true;
    this.acquiredAt = now;
    return true;
  }

  isActive(): boolean {
    return this.active;
  }

  release(): boolean {
    if (!this.active) return false;
    this.active = false;
    this.acquiredAt = 0;
    return true;
  }

  ageMs(now = Date.now()): number | null {
    return this.active ? Math.max(0, now - this.acquiredAt) : null;
  }
}
