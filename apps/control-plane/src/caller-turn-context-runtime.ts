export type CallerTurnContextSnapshot = Readonly<{
  effectiveTurn: string | null;
  fragmentCount: number;
}>;

/**
 * Provider-neutral context for the effective caller turn after structural fragment
 * consolidation. This is the only supported cross-component access path; callers
 * must not read another CallSession generation's private fields.
 */
export class CallerTurnContextRuntime {
  private effectiveTurn: string | null = null;
  private fragmentCount = 0;

  setEffectiveTurn(turn: string, fragmentCount = 1): void {
    const normalized = turn.replace(/\s+/g, " ").trim();
    this.effectiveTurn = normalized || null;
    this.fragmentCount = this.effectiveTurn ? Math.max(1, fragmentCount) : 0;
  }

  clear(): void {
    this.effectiveTurn = null;
    this.fragmentCount = 0;
  }

  current(): string | null {
    return this.effectiveTurn;
  }

  snapshot(): CallerTurnContextSnapshot {
    return Object.freeze({ effectiveTurn: this.effectiveTurn, fragmentCount: this.fragmentCount });
  }
}

const runtimes = new WeakMap<object, CallerTurnContextRuntime>();

export function callerTurnContextRuntimeFor(session: object): CallerTurnContextRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new CallerTurnContextRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
