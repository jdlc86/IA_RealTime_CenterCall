export type ReservationDatetimeValidityDecision =
  | { kind: "ALLOW"; startsAtEpochMs: number }
  | { kind: "REJECT_INVALID"; reason: "INVALID_DATETIME" }
  | { kind: "REJECT_PAST"; reason: "RESERVATION_DATETIME_IN_PAST"; startsAtEpochMs: number; nowEpochMs: number };

/**
 * Backend authority for the most basic temporal invariant of a reservation:
 * a reservation may never proceed when its normalized start instant is not in
 * the future. The caller supplies `nowEpochMs` so tests are deterministic and
 * runtime evaluation uses the actual Worker clock rather than model context.
 */
export function decideReservationDatetimeValidity(
  normalizedStartsAt: string,
  nowEpochMs: number,
): ReservationDatetimeValidityDecision {
  const startsAtEpochMs = Date.parse(normalizedStartsAt);
  if (!Number.isFinite(startsAtEpochMs)) {
    return { kind: "REJECT_INVALID", reason: "INVALID_DATETIME" };
  }
  if (startsAtEpochMs <= nowEpochMs) {
    return {
      kind: "REJECT_PAST",
      reason: "RESERVATION_DATETIME_IN_PAST",
      startsAtEpochMs,
      nowEpochMs,
    };
  }
  return { kind: "ALLOW", startsAtEpochMs };
}
