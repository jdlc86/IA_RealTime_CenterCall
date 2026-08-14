const BOOKED_MARKER = "La reserva está confirmada por el backend.";
const MARKETING_RESULT_MARKER = "Responde de forma breve usando únicamente este resultado autorizado de preferencias comerciales:";
const TERMINAL_RESULT_MARKERS = [
  "Usa únicamente este resultado autorizado de cancelación:",
  "Indica que no has encontrado reservas futuras confirmadas asociadas al mismo número desde el que está llamando.",
  "Informa de las reservas futuras confirmadas asociadas a esta llamada usando únicamente estos resultados verificados:",
];

const CONTINUATION_INSTRUCTION = " Después de comunicar el resultado, pregunta exactamente: ¿Necesitas algo más en lo que pueda ayudarte? No dejes la llamada abierta en silencio ni esperes a que el usuario hable para devolverle el control de la conversación.";

export function applyTerminalConversationPolicy(instructions: string): string {
  if (instructions.includes(BOOKED_MARKER)) {
    return `${instructions}${CONTINUATION_INSTRUCTION} No anuncies que hablarás de ofertas o promociones más tarde.`;
  }

  if (instructions.includes(MARKETING_RESULT_MARKER)) {
    return `${instructions}${CONTINUATION_INSTRUCTION} No anuncies futuras ofertas o promociones.`;
  }

  if (TERMINAL_RESULT_MARKERS.some((marker) => instructions.includes(marker))) {
    return `${instructions}${CONTINUATION_INSTRUCTION}`;
  }

  return instructions;
}
