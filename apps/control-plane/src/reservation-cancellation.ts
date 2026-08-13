import type { BookedReservationSummary } from "./supabase-adapter.js";
import type { ReservationTurn } from "./reservation-orchestrator.js";

export type CancellationState = {
  candidates: BookedReservationSummary[];
  selectedIds: string[];
  confirmationFingerprints: Record<string, string>;
};

export function emptyCancellationState(): CancellationState {
  return { candidates: [], selectedIds: [], confirmationFingerprints: {} };
}

export function cancellationFingerprint(reservation: BookedReservationSummary): string {
  return JSON.stringify({ id: reservation.id, starts_at: reservation.starts_at, party_size: reservation.party_size, status: reservation.status });
}

export function chooseCancellationCandidates(candidates: BookedReservationSummary[], turn: ReservationTurn): BookedReservationSummary[] {
  if (candidates.length === 0) return [];
  if (turn.selectAll === true) return [...candidates];
  if (turn.selectionIndexes?.length) {
    return turn.selectionIndexes.map((index) => candidates[index - 1]).filter((value): value is BookedReservationSummary => Boolean(value));
  }
  if (turn.selectionIndex !== undefined) {
    const selected = candidates[turn.selectionIndex - 1];
    return selected ? [selected] : [];
  }
  if (candidates.length === 1) return [candidates[0]];
  return [];
}

export function publicCancellationOptions(candidates: BookedReservationSummary[]): Array<{ option: number; starts_at: string; party_size: number; customer_name: string }> {
  return candidates.map((reservation, index) => ({
    option: index + 1,
    starts_at: reservation.starts_at,
    party_size: reservation.party_size,
    customer_name: reservation.customer_name,
  }));
}

export function publicSelectedReservations(candidates: BookedReservationSummary[]): Array<{ starts_at: string; party_size: number; customer_name: string }> {
  return candidates.map((reservation) => ({ starts_at: reservation.starts_at, party_size: reservation.party_size, customer_name: reservation.customer_name }));
}
