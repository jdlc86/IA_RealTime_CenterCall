import type { RealtimeToolResultRequest } from "./realtime-provider-command-port.js";

const SEARCH_RESERVATION = "restaurant_reservation_search";
export const RESERVATION_TIMEZONE = "Europe/Madrid";
export const RESERVATION_SEARCH_LOCAL_TIME_INSTRUCTION = "Presenta como máximo tres opciones usando starts_at_local (hora de Madrid). Nunca verbalices ni reutilices starts_at_utc como si fuese hora local. Estas opciones ya están filtradas por horario comercial; no reserves hasta que el cliente elija una y pase por restaurant_reservation_create.";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function formatMadridReservationTime(iso: string): string | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: RESERVATION_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}`;
}

/**
 * Enriches reservation-search suggestions before provider translation.
 * The transform is provider-neutral and does not mutate the original request.
 */
export function localizeReservationSearchToolResult(request: RealtimeToolResultRequest): RealtimeToolResultRequest {
  if (request.toolName !== SEARCH_RESERVATION) return request;
  const payload = asObject(request.output);
  if (!payload || payload.status !== "SUGGESTIONS_AVAILABLE" || !Array.isArray(payload.options)) return request;

  const options = payload.options.map((value) => {
    const option = asObject(value);
    if (!option) return value;
    const startsAt = typeof option.starts_at === "string" ? option.starts_at : null;
    return {
      ...option,
      starts_at_utc: option.starts_at,
      starts_at_local: startsAt ? formatMadridReservationTime(startsAt) : null,
      timezone: RESERVATION_TIMEZONE,
    };
  });

  return {
    ...request,
    output: {
      ...payload,
      timezone: RESERVATION_TIMEZONE,
      options,
      instruction: RESERVATION_SEARCH_LOCAL_TIME_INSTRUCTION,
    },
  };
}
