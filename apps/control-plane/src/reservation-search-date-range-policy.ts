export const CALLER_AUTHORIZED_RANGE = "CALLER_AUTHORIZED_RANGE";

export type ReservationSearchDateRangeDecision =
  | { action: "SAME_DATE" }
  | { action: "ALLOW_RANGE"; daySpan: number }
  | { action: "BLOCK_RANGE"; reason: "CALLER_RANGE_AUTHORITY_REQUIRED" | "INVALID_RANGE" | "RANGE_TOO_WIDE" };

function epochDay(localDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 86_400_000) : null;
}

/**
 * Keeps cross-date search authority explicit without interpreting caller words.
 * The model owns natural-language understanding and must state semantically that
 * the caller authorized a range; this policy only validates the materialized
 * range and prevents an implicit or unbounded expansion.
 */
export function decideReservationSearchDateRange(input: {
  fromLocalDate: string;
  toLocalDate: string | null;
  dateScope: string | null;
}): ReservationSearchDateRangeDecision {
  if (!input.toLocalDate || input.toLocalDate === input.fromLocalDate) return { action: "SAME_DATE" };
  const fromDay = epochDay(input.fromLocalDate);
  const toDay = epochDay(input.toLocalDate);
  if (fromDay === null || toDay === null || toDay <= fromDay) {
    return { action: "BLOCK_RANGE", reason: "INVALID_RANGE" };
  }
  const daySpan = toDay - fromDay;
  if (daySpan > 7) return { action: "BLOCK_RANGE", reason: "RANGE_TOO_WIDE" };
  if (input.dateScope !== CALLER_AUTHORIZED_RANGE) {
    return { action: "BLOCK_RANGE", reason: "CALLER_RANGE_AUTHORITY_REQUIRED" };
  }
  return { action: "ALLOW_RANGE", daySpan };
}
