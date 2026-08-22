export type TurnOwnershipSnapshot = Readonly<{
  semanticOwnerItemId: string | null;
}>;

/** Cross-layer turn ownership contract. No versioned CallSession methods are exposed. */
export class TurnOwnershipRuntime {
  private semanticOwnerItemId: string | null = null;

  claimSemanticItem(itemId: string): void {
    this.semanticOwnerItemId = itemId || null;
  }

  releaseSemanticItem(itemId?: string | null): void {
    if (itemId && this.semanticOwnerItemId && itemId !== this.semanticOwnerItemId) return;
    this.semanticOwnerItemId = null;
  }

  ownsSemanticItem(itemId: string | null | undefined): boolean {
    return Boolean(itemId && this.semanticOwnerItemId === itemId);
  }

  snapshot(): TurnOwnershipSnapshot {
    return Object.freeze({ semanticOwnerItemId: this.semanticOwnerItemId });
  }
}

const runtimes = new WeakMap<object, TurnOwnershipRuntime>();

export function turnOwnershipRuntimeFor(session: object): TurnOwnershipRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new TurnOwnershipRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
