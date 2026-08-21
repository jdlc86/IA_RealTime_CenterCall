import { decideReservationDatetimeValidity } from "./reservation-datetime-validity.js";
import { realtimeCommandPortFor } from "./realtime-provider-runtime.js";

export const RESERVATION_TIMEZONE = "Europe/Madrid";

export type ReservationDatetimeAuthorityRequest = Readonly<{
  callId?: string;
  arguments: Record<string, unknown>;
  nowEpochMs?: number;
}>;

export type ReservationDatetimeAuthorityResult =
  | Readonly<{ allowed: true; arguments: Record<string, unknown> }>
  | Readonly<{ allowed: false }>;

function hasExplicitZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
}

function parseLocalIso(value: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };
}

function partsInTimeZone(epochMs: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function localPartsEpoch(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number }): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

export function normalizeMadridReservationIso(value: string): string {
  const trimmed = value.trim();
  if (hasExplicitZone(trimmed)) return trimmed;
  const target = parseLocalIso(trimmed);
  if (!target) return trimmed;

  const targetEpoch = localPartsEpoch(target);
  let candidateUtc = targetEpoch;
  for (let i = 0; i < 3; i += 1) {
    const rendered = partsInTimeZone(candidateUtc, RESERVATION_TIMEZONE);
    const deltaMs = localPartsEpoch(rendered) - targetEpoch;
    if (deltaMs === 0) break;
    candidateUtc -= deltaMs;
  }

  const verified = partsInTimeZone(candidateUtc, RESERVATION_TIMEZONE);
  if (localPartsEpoch(verified) !== targetEpoch) {
    throw new Error(`La hora local ${trimmed} no existe o es ambigua en ${RESERVATION_TIMEZONE}`);
  }

  const offsetMinutes = Math.round((targetEpoch - candidateUtc) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const offsetMins = String(absolute % 60).padStart(2, "0");
  const seconds = String(target.second).padStart(2, "0");
  return `${String(target.year).padStart(4, "0")}-${String(target.month).padStart(2, "0")}-${String(target.day).padStart(2, "0")}T${String(target.hour).padStart(2, "0")}:${String(target.minute).padStart(2, "0")}:${seconds}${sign}${offsetHours}:${offsetMins}`;
}

function rejectionInstruction(status: string): string {
  return status === "RESERVATION_DATETIME_IN_PAST"
    ? "La fecha u hora solicitada ya ha pasado. No confirmes ni consultes disponibilidad para esa fecha. Pide al cliente una nueva fecha y hora futuras y espera su respuesta."
    : "La fecha u hora indicada no es válida. Pide al cliente una nueva fecha y hora y espera su respuesta.";
}

/**
 * Version-neutral owner for reservation datetime normalization and the basic
 * future-instant invariant. It operates on parsed semantic tool arguments and
 * emits rejection only through the provider-neutral command boundary.
 */
export class ReservationDatetimeRuntime {
  canonicalizeCreate(session: object, request: ReservationDatetimeAuthorityRequest): ReservationDatetimeAuthorityResult {
    const rawStartsAt = typeof request.arguments.starts_at === "string"
      ? request.arguments.starts_at.trim()
      : null;
    if (!rawStartsAt) return { allowed: true, arguments: request.arguments };

    try {
      const normalizedStartsAt = normalizeMadridReservationIso(rawStartsAt);
      if (normalizedStartsAt !== rawStartsAt) {
        (session as any).diagnostics?.checkpoint?.("RESERVATION_DATETIME_NORMALIZED_V20", {
          source_timezone: RESERVATION_TIMEZONE,
          original_starts_at: rawStartsAt,
          normalized_starts_at: normalizedStartsAt,
          authority_owner: "reservation_datetime_runtime",
        });
      }

      const temporalDecision = decideReservationDatetimeValidity(
        normalizedStartsAt,
        request.nowEpochMs ?? Date.now(),
      );
      if (temporalDecision.kind !== "ALLOW") {
        (session as any).diagnostics?.checkpoint?.("RESERVATION_DATETIME_REJECTED_V20", {
          reason: temporalDecision.reason,
          original_starts_at: rawStartsAt,
          normalized_starts_at: normalizedStartsAt,
          availability_checked: false,
          confirmation_reached: false,
          authority_owner: "reservation_datetime_runtime",
        });
        const port = realtimeCommandPortFor(session as any);
        port.submitToolResult({
          callId: request.callId,
          toolName: "restaurant_reservation_create",
          output: {
            ok: false,
            stage: "COLLECT_RESERVATION_DATA",
            status: temporalDecision.reason,
            starts_at: normalizedStartsAt,
            reservation_created: false,
            availability_checked: false,
            explicit_confirmation_required: false,
            instruction: rejectionInstruction(temporalDecision.reason),
          },
        });
        port.createDefaultResponse();
        return { allowed: false };
      }

      if (normalizedStartsAt === rawStartsAt) {
        return { allowed: true, arguments: request.arguments };
      }
      return {
        allowed: true,
        arguments: { ...request.arguments, starts_at: normalizedStartsAt },
      };
    } catch (error) {
      // Preserve the historical V20 compatibility contract: normalization
      // failures are diagnosed but lower reservation/backend validation still
      // receives the original parsed arguments.
      (session as any).diagnostics?.fail?.(
        "RESERVATION_DATETIME_NORMALIZATION_FAILED_V20",
        "RESERVATION_DATETIME_INVALID",
        {
          error: error instanceof Error ? error.message : String(error),
          authority_owner: "reservation_datetime_runtime",
          lower_validation_preserved: true,
        },
      );
      return { allowed: true, arguments: request.arguments };
    }
  }
}

const runtimes = new WeakMap<object, ReservationDatetimeRuntime>();

export function reservationDatetimeRuntimeFor(session: object): ReservationDatetimeRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new ReservationDatetimeRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
