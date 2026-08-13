export type ReservationTruthClaim = "BOOKED" | "CANCELLED" | null;

function normalizeSpeech(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function classifyReservationTruthClaim(value: string): ReservationTruthClaim {
  const text = normalizeSpeech(value);
  const reservationWord = /\breserva(?:cion)?\b/.test(text);
  if (!reservationWord) return null;

  const cancelled = /\b(cancelad[ao]|anulad[ao]|dada de baja)\b/.test(text)
    && /\b(he|hemos|queda|quedo|esta|ya esta|acabo de|ha sido)\b/.test(text);
  if (cancelled) return "CANCELLED";

  const bookedWord = /\b(confirmad[ao]|hecha|realizada|completada|registrada|reservad[ao]|lista)\b/.test(text);
  const explicitVerb = /\b(he|hemos|queda|quedo|esta|ya esta|acabo de)\b/.test(text);
  return bookedWord && explicitVerb ? "BOOKED" : null;
}
