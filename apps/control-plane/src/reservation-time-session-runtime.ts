export type ReservationTimeTool = "restaurant_reservation_create" | "restaurant_reservation_modify";

export type ReservationTimeAuthoritySnapshot = Readonly<{
  latestCallerTurn: string | null;
  callerTurnEpoch: number;
  awaitingTimeAnswer: boolean;
  createStartsAt: string | null;
  modifyStartsAt: string | null;
  offeredStartsAt: readonly string[];
}>;

/** Single owner for caller-derived reservation-time authority during a call. */
export class ReservationTimeSessionRuntime {
  private latestCallerTurn: string | null = null;
  private callerTurnEpoch = 0;
  private awaitingTimeAnswer = false;
  private authorizedStartsAt: Partial<Record<ReservationTimeTool, string>> = {};
  private offeredStartsAt: string[] = [];
  private offeredAtCallerTurnEpoch = -1;

  snapshot(): ReservationTimeAuthoritySnapshot {
    return Object.freeze({
      latestCallerTurn: this.latestCallerTurn,
      callerTurnEpoch: this.callerTurnEpoch,
      awaitingTimeAnswer: this.awaitingTimeAnswer,
      createStartsAt: this.authorizedStartsAt.restaurant_reservation_create ?? null,
      modifyStartsAt: this.authorizedStartsAt.restaurant_reservation_modify ?? null,
      offeredStartsAt: Object.freeze([...this.offeredStartsAt]),
    });
  }

  observeCallerTurn(turn: string): void {
    const normalized = turn.replace(/\s+/g, " ").trim();
    if (normalized) {
      this.latestCallerTurn = normalized;
      this.callerTurnEpoch += 1;
    }
  }

  recordOfferedSlots(startsAt: readonly string[]): void {
    this.offeredStartsAt = startsAt.filter((value) => Number.isFinite(Date.parse(value)));
    this.offeredAtCallerTurnEpoch = this.callerTurnEpoch;
  }

  matchesOfferedSlotAfterCallerTurn(startsAt: string): boolean {
    const requestedInstant = Date.parse(startsAt);
    if (!Number.isFinite(requestedInstant) || this.callerTurnEpoch <= this.offeredAtCallerTurnEpoch) return false;
    return this.offeredStartsAt.some((offered) => Date.parse(offered) === requestedInstant);
  }

  markAwaitingTimeAnswer(): void {
    this.awaitingTimeAnswer = true;
  }

  pendingSlot(): "starts_at_time" | null {
    return this.awaitingTimeAnswer ? "starts_at_time" : null;
  }

  latestTurn(): string | null {
    return this.latestCallerTurn;
  }

  authorizedFor(tool: ReservationTimeTool): string | null {
    return this.authorizedStartsAt[tool] ?? null;
  }

  establish(tool: ReservationTimeTool, startsAt: string): { resolvedPendingSlot: boolean } {
    const resolvedPendingSlot = this.awaitingTimeAnswer;
    this.authorizedStartsAt[tool] = startsAt;
    this.awaitingTimeAnswer = false;
    return { resolvedPendingSlot };
  }

  markReused(): void {
    this.awaitingTimeAnswer = false;
  }

  consume(tool: ReservationTimeTool): void {
    delete this.authorizedStartsAt[tool];
    this.latestCallerTurn = null;
    this.awaitingTimeAnswer = false;
    this.offeredStartsAt = [];
    this.offeredAtCallerTurnEpoch = -1;
  }
}

const runtimes = new WeakMap<object, ReservationTimeSessionRuntime>();

export function reservationTimeSessionRuntimeFor(session: object): ReservationTimeSessionRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new ReservationTimeSessionRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
