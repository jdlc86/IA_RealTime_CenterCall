export type ReservationOutputStage =
  | "COLLECTING"
  | "READY_TO_CONFIRM"
  | "BOOKED"
  | "UNAVAILABLE"
  | "FAILED";

export type ReservationStageSignals = {
  booked: boolean;
  confirmationArmed: boolean;
  instructions: string;
};

export function deriveReservationOutputStage(signals: ReservationStageSignals): ReservationOutputStage {
  if (signals.booked) return "BOOKED";
  if (signals.confirmationArmed) return "READY_TO_CONFIRM";
  const text = signals.instructions.toLowerCase();
  if (text.includes("no hay disponibilidad")) return "UNAVAILABLE";
  if (text.includes("no ha podido") || text.includes("no puedes") || text.includes("no se ha creado")) return "FAILED";
  return "COLLECTING";
}

export function applyReservationOutputPolicy(instructions: string, stage: ReservationOutputStage): string {
  if (stage === "BOOKED") return instructions;

  if (stage === "READY_TO_CONFIRM") {
    return `${instructions} Estado backend: READY_TO_CONFIRM. Limítate a resumir los datos autorizados y pedir una confirmación explícita. No digas que la reserva está hecha, confirmada, procesada, completada ni realizada.`;
  }

  if (stage === "UNAVAILABLE") {
    return `${instructions} Estado backend: UNAVAILABLE. No insinúes que existe una reserva ni que se está procesando una. Ofrece únicamente opciones verificadas o pide otra fecha/hora.`;
  }

  if (stage === "FAILED") {
    return `${instructions} Estado backend: FAILED. Indica únicamente que la operación no se ha completado. No uses lenguaje de éxito ni de procesamiento en curso.`;
  }

  return `${instructions} Estado backend: COLLECTING. Formula únicamente la pregunta o aclaración solicitada. No digas que vas a procesar, tramitar, realizar, completar o confirmar la reserva y no sugieras que ya está en curso una creación de reserva.`;
}

export function isLegacyReservationContinueOutput(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const event = data as Record<string, unknown>;
  if (event.type !== "conversation.item.create") return false;
  const item = event.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const output = (item as Record<string, unknown>).output;
  if (typeof output !== "string") return false;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return parsed.data_requirement === "RESERVATION"
      && parsed.reservation_orchestrator === "backend_v1"
      && parsed.action === "continue";
  } catch {
    return false;
  }
}

export function rewriteReservationClassifierOutput(data: unknown, stage: ReservationOutputStage): unknown {
  if (!isLegacyReservationContinueOutput(data)) return data;
  const event = data as Record<string, unknown>;
  const item = event.item as Record<string, unknown>;
  const parsed = JSON.parse(item.output as string) as Record<string, unknown>;
  return {
    ...event,
    item: {
      ...item,
      output: JSON.stringify({
        ...parsed,
        action: "backend_orchestrated",
        stage,
      }),
    },
  };
}
