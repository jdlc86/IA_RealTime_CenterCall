import type { BookedReservationSummary } from "./supabase-adapter.js";

export function publicReservationQueryResults(rows: BookedReservationSummary[]): Array<Record<string, unknown>> {
  return rows.map((row, index) => ({
    option: index + 1,
    reservation_code: row.reservation_code,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    party_size: row.party_size,
    customer_name: row.customer_name,
    status: row.status,
  }));
}
