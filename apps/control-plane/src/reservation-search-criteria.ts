export type ReservationSearchCriteria = {
  partySize: number;
  preferredStartsAt?: string;
  dateFrom?: string;
  dateTo?: string;
  timeFrom?: string;
  timeTo?: string;
  durationMinutes: number;
  stepMinutes: number;
  maxResults: number;
};

export function normalizeReservationSearchCriteria(input: Record<string, unknown>): ReservationSearchCriteria {
  const partySize = Number(input.party_size);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 100) throw new Error("invalid party_size");
  const durationMinutes = input.duration_minutes === undefined ? 90 : Number(input.duration_minutes);
  const stepMinutes = input.step_minutes === undefined ? 30 : Number(input.step_minutes);
  const maxResults = input.max_results === undefined ? 5 : Number(input.max_results);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) throw new Error("invalid duration_minutes");
  if (!Number.isInteger(stepMinutes) || stepMinutes < 15 || stepMinutes > 120) throw new Error("invalid step_minutes");
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) throw new Error("invalid max_results");
  const read = (key: string): string | undefined => typeof input[key] === "string" && input[key].trim() ? input[key].trim() : undefined;
  return { partySize, preferredStartsAt: read("preferred_starts_at"), dateFrom: read("date_from"), dateTo: read("date_to"), timeFrom: read("time_from"), timeTo: read("time_to"), durationMinutes, stepMinutes, maxResults };
}
