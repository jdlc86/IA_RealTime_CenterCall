import {
  decideReservationDateScope,
  type ReservationDateScopeDecision,
  type ReservationDateScopePendingChange,
} from "./reservation-date-scope-policy.js";

export type ReservationDateScopeSnapshot = Readonly<{
  activeLocalDate: string | null;
  pendingChange: ReservationDateScopePendingChange | null;
  callerTurnEpoch: number;
  lastCallerTranscriptItemId: string | null;
}>;

/** Single owner for reservation-date continuity state during a call. */
export class ReservationDateScopeRuntime {
  private activeLocalDate: string | null = null;
  private pendingChange: ReservationDateScopePendingChange | null = null;
  private callerTurnEpoch = 0;
  private lastCallerTranscriptItemId: string | null = null;

  snapshot(): ReservationDateScopeSnapshot {
    return Object.freeze({
      activeLocalDate: this.activeLocalDate,
      pendingChange: this.pendingChange ? { ...this.pendingChange } : null,
      callerTurnEpoch: this.callerTurnEpoch,
      lastCallerTranscriptItemId: this.lastCallerTranscriptItemId,
    });
  }

  observeCallerTranscript(transcript: string, itemId?: string): { observed: boolean; callerTurnEpoch: number } {
    if (!transcript.trim()) return { observed: false, callerTurnEpoch: this.callerTurnEpoch };
    if (itemId) {
      if (itemId === this.lastCallerTranscriptItemId) {
        return { observed: false, callerTurnEpoch: this.callerTurnEpoch };
      }
      this.lastCallerTranscriptItemId = itemId;
    } else {
      this.lastCallerTranscriptItemId = null;
    }
    this.callerTurnEpoch += 1;
    return { observed: true, callerTurnEpoch: this.callerTurnEpoch };
  }

  decide(requestedLocalDate: string): ReservationDateScopeDecision {
    return decideReservationDateScope({
      activeLocalDate: this.activeLocalDate,
      requestedLocalDate,
      pendingChange: this.pendingChange,
      currentCallerTurnEpoch: this.callerTurnEpoch,
    });
  }

  stagePendingChange(fromLocalDate: string, toLocalDate: string): void {
    this.pendingChange = {
      fromLocalDate,
      toLocalDate,
      requestedAtCallerTurnEpoch: this.callerTurnEpoch,
    };
  }

  accept(decision: Exclude<ReservationDateScopeDecision, { action: "REQUIRE_CONFIRMATION" }>): void {
    if (decision.action === "ALLOW_AND_SET" || decision.action === "ALLOW_CONFIRMED_CHANGE") {
      this.activeLocalDate = decision.localDate;
    }
    this.pendingChange = null;
  }
}

const runtimes = new WeakMap<object, ReservationDateScopeRuntime>();

export function reservationDateScopeRuntimeFor(session: object): ReservationDateScopeRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new ReservationDateScopeRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
