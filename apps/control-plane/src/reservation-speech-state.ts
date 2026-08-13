export type ReservationSpeechTruthState = "NO_ACTIVE_CREATE" | "PENDING_NOT_BOOKED" | "BOOKED";

export function reservationSpeechTruthState(input: {
  reservationBookedThisCall: boolean;
  reservationDraft: unknown;
}): ReservationSpeechTruthState {
  if (input.reservationBookedThisCall) return "BOOKED";
  if (input.reservationDraft && typeof input.reservationDraft === "object" && !Array.isArray(input.reservationDraft) && Object.keys(input.reservationDraft as Record<string, unknown>).length > 0) {
    return "PENDING_NOT_BOOKED";
  }
  return "NO_ACTIVE_CREATE";
}

export function applyReservationSpeechTruth(instructions: string, state: ReservationSpeechTruthState): string {
  if (state === "NO_ACTIVE_CREATE") return instructions;
  if (state === "BOOKED") {
    return `${instructions}\n\nESTADO AUTORITATIVO DE RESERVA: BOOKED. Solo puedes afirmar que la reserva está confirmada porque el backend ya registró evidencia BOOKED.`;
  }
  return `${instructions}\n\nESTADO AUTORITATIVO DE RESERVA: PENDING_NOT_BOOKED. No existe evidencia BOOKED. Está terminantemente prohibido afirmar o insinuar que la reserva está confirmada, hecha, registrada, completada o reservada. Si necesitas describir el estado, di únicamente que la reserva todavía no está confirmada y continúa con el siguiente paso autorizado por el backend.`;
}
