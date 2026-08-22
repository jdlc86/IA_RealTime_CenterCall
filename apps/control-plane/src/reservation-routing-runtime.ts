import type { BookedReservationSummary } from "./restaurant-reservation-port.js";
import type { CancellationState } from "./reservation-cancellation.js";

export type ReservationRoutingSnapshot = Readonly<{
  createIntentActive: boolean;
  cancellationActive: boolean;
}>;

function cloneCancellation(state: CancellationState): CancellationState {
  return {
    candidates: state.candidates.map((candidate) => ({ ...candidate })),
    selectedIds: [...state.selectedIds],
    confirmationFingerprints: { ...state.confirmationFingerprints },
  };
}

/**
 * Session-scoped owner for reservation routing continuity. CallSession layers
 * may report routing facts and consume snapshots, but no generation owns or
 * reaches into another generation's workflow flags.
 */
export class ReservationRoutingRuntime {
  private createIntentActive = false;
  private cancellationState: CancellationState | null = null;

  snapshot(): ReservationRoutingSnapshot {
    return Object.freeze({
      createIntentActive: this.createIntentActive,
      cancellationActive: this.cancellationState !== null,
    });
  }

  markCreateIntentActive(): void {
    this.createIntentActive = true;
  }

  clearCreateIntent(): void {
    this.createIntentActive = false;
  }

  startCancellation(candidates: BookedReservationSummary[]): CancellationState {
    this.cancellationState = {
      candidates: candidates.map((candidate) => ({ ...candidate })),
      selectedIds: [],
      confirmationFingerprints: {},
    };
    return cloneCancellation(this.cancellationState);
  }

  cancellation(): CancellationState | null {
    return this.cancellationState ? cloneCancellation(this.cancellationState) : null;
  }

  selectCancellation(selectedIds: string[], confirmationFingerprints: Record<string, string>): CancellationState {
    if (!this.cancellationState) throw new Error("Cancellation routing is not active");
    this.cancellationState = {
      ...this.cancellationState,
      selectedIds: [...selectedIds],
      confirmationFingerprints: { ...confirmationFingerprints },
    };
    return cloneCancellation(this.cancellationState);
  }

  clearCancellation(): void {
    this.cancellationState = null;
  }
}

const runtimes = new WeakMap<object, ReservationRoutingRuntime>();

export function reservationRoutingRuntimeFor(session: object): ReservationRoutingRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new ReservationRoutingRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
