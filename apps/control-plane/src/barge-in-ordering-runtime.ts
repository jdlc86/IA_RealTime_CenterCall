export class BargeInOrderingRuntime {
  private latestStartedItemId: string | null = null;
  private latestCompletedItemId: string | null = null;

  observeSpeechStarted(itemId: string | null | undefined): { previous: string | null; current: string | null } {
    const previous = this.latestStartedItemId;
    if (itemId) this.latestStartedItemId = itemId;
    return { previous, current: this.latestStartedItemId };
  }

  observeTranscriptCompleted(itemId: string | null | undefined): void {
    if (itemId) this.latestCompletedItemId = itemId;
  }

  latestStarted(): string | null { return this.latestStartedItemId; }
  latestCompleted(): string | null { return this.latestCompletedItemId; }

  reset(): void {
    this.latestStartedItemId = null;
    this.latestCompletedItemId = null;
  }
}

const runtimes = new WeakMap<object, BargeInOrderingRuntime>();
export function bargeInOrderingRuntimeFor(session: object): BargeInOrderingRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) { runtime = new BargeInOrderingRuntime(); runtimes.set(session, runtime); }
  return runtime;
}
