import type { BookedReservationSummary } from "./supabase-adapter.js";
import type { ReservationTurn } from "./reservation-orchestrator.js";

export type CancellationState = {
  candidates: BookedReservationSummary[];
  selectedId: string | null;
  confirmationFingerprint: string | null;
};

export function emptyCancellationState(): CancellationState {
  return { candidates: [], selectedId: null, confirmationFingerprint: null };
}

export function cancellationFingerprint(reservation: BookedReservationSummary): string {
  return JSON.stringify({ id: reservation.id, starts_at: reservation.starts_at, party_size: reservation.party_size, status: reservation.status });
}

export function chooseCancellationCandidate(candidates: BookedReservationSummary[], turn: ReservationTurn): BookedReservationSummary | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1 && turn.selectionIndex === undefined) return candidates[0];
  if (turn.selectionIndex === undefined) return null;
  return candidates[turn.selectionIndex - 1] ?? null;
}

export function publicCancellationOptions(candidates: BookedReservationSummary[]): Array<{ option: number; starts_at: string; party_size: number; customer_name: string }> {
  return candidates.map((reservation, index) => ({
    option: index + 1,
    starts_at: reservation.starts_at,
    party_size: reservation.party_size,
    customer_name: reservation.customer_name,
  }));
}
