import type { ToolResult } from "./tool-gateway.js";

export const RESERVATION_AVAILABILITY_CHANGED_STATUS = "AVAILABILITY_CHANGED";

const RESERVATION_CONFLICT_MARKERS = [
  "reservation_availability_changed",
  "no_availability",
  "no_multitable_availability",
  "reservation_overlap_conflict",
  '"code":"23p01"',
];

export function isReservationAvailabilityConflict(result: ToolResult): boolean {
  if (result.ok || !("error" in result) || !("message" in result)) return false;
  const normalized = `${result.error} ${result.message}`.toLowerCase();
  return RESERVATION_CONFLICT_MARKERS.some((marker) => normalized.includes(marker));
}

export function reservationAvailabilityChangedOutput(reservation: {
  party_size?: number;
  starts_at?: string;
  customer_name?: string;
  duration_minutes?: number;
}): Record<string, unknown> {
  return {
    ok: true,
    status: RESERVATION_AVAILABILITY_CHANGED_STATUS,
    stage: RESERVATION_AVAILABILITY_CHANGED_STATUS,
    requested_available: false,
    reservation_created: false,
    requires_new_confirmation: true,
    retryable: true,
    conflict_reason: "COMMIT_TIME_CAPACITY_CONFLICT",
    offer_alternative_search: true,
    alternative_search_scope: "SAME_LOCAL_DATE",
    auto_search_same_response: false,
    requested: {
      party_size: reservation.party_size,
      starts_at: reservation.starts_at,
      customer_name: reservation.customer_name,
      duration_minutes: reservation.duration_minutes ?? 90,
    },
    instruction:
      "La disponibilidad cambió durante la confirmación y no se creó ninguna reserva. " +
      "No lo presentes como un error técnico. Informa del cambio y pregunta si el cliente quiere buscar horarios cercanos en esa misma fecha. " +
      "No hagas una búsqueda automática en esta misma respuesta: una transacción concurrente puede seguir cerrando su commit. " +
      "Conserva los datos de contacto ya recogidos y exige una nueva confirmación explícita antes de reservar cualquier alternativa.",
  };
}
