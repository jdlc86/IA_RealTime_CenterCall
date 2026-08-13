const BOOKED_MARKER = "La reserva está confirmada por el backend.";
const MARKETING_RESULT_MARKER = "Responde de forma breve usando únicamente este resultado autorizado de preferencias comerciales:";

export function applyPostBookingConversationPolicy(instructions: string): string {
  if (instructions.includes(BOOKED_MARKER)) {
    return `${instructions} Después de resolver en este mismo turno cualquier pregunta comercial que realmente corresponda, pregunta de forma natural y breve: ¿Puedo ayudarte con algo más? No dejes la llamada abierta en silencio. No anuncies que hablarás de ofertas o promociones más tarde.`;
  }

  if (instructions.includes(MARKETING_RESULT_MARKER)) {
    return `${instructions} Después de comunicar el resultado, pregunta de forma natural y breve: ¿Puedo ayudarte con algo más? No dejes la llamada abierta en silencio y no anuncies futuras ofertas o promociones.`;
  }

  return instructions;
}
