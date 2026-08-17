import { CallSession as CallSessionV19 } from "./call-session-v19";
import { realtimeCommandPortFor } from "./openai-realtime-command-adapter";
import { decideReservationDatetimeValidity } from "./reservation-datetime-validity";

const BaseConstructor = CallSessionV19 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV19.prototype as any;
const CREATE_RESERVATION = "restaurant_reservation_create";
const RESTAURANT_TIMEZONE = "Europe/Madrid";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

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

function normalizeMadridLocalIso(value: string): string {
  const trimmed = value.trim();
  if (hasExplicitZone(trimmed)) return trimmed;
  const target = parseLocalIso(trimmed);
  if (!target) return trimmed;

  const targetEpoch = localPartsEpoch(target);
  let candidateUtc = targetEpoch;
  for (let i = 0; i < 3; i += 1) {
    const rendered = partsInTimeZone(candidateUtc, RESTAURANT_TIMEZONE);
    const deltaMs = localPartsEpoch(rendered) - targetEpoch;
    if (deltaMs === 0) break;
    candidateUtc -= deltaMs;
  }

  const verified = partsInTimeZone(candidateUtc, RESTAURANT_TIMEZONE);
  if (localPartsEpoch(verified) !== targetEpoch) {
    throw new Error(`La hora local ${trimmed} no existe o es ambigua en ${RESTAURANT_TIMEZONE}`);
  }

  const offsetMinutes = Math.round((targetEpoch - candidateUtc) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const offsetMins = String(absolute % 60).padStart(2, "0");
  const seconds = String(target.second).padStart(2, "0");
  return `${String(target.year).padStart(4, "0")}-${String(target.month).padStart(2, "0")}-${String(target.day).padStart(2, "0")}T${String(target.hour).padStart(2, "0")}:${String(target.minute).padStart(2, "0")}:${seconds}${sign}${offsetHours}:${offsetMins}`;
}

export class CallSession extends BaseConstructor {
  private rejectReservationDatetimeV20(event: RealtimeEvent, status: string, normalizedStartsAt: string): void {
    (this as any).send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({
          ok: false,
          stage: "COLLECT_RESERVATION_DATA",
          status,
          starts_at: normalizedStartsAt,
          reservation_created: false,
          availability_checked: false,
          explicit_confirmation_required: false,
          instruction: status === "RESERVATION_DATETIME_IN_PAST"
            ? "La fecha u hora solicitada ya ha pasado. No confirmes ni consultes disponibilidad para esa fecha. Pide al cliente una nueva fecha y hora futuras y espera su respuesta."
            : "La fecha u hora indicada no es válida. Pide al cliente una nueva fecha y hora y espera su respuesta.",
        }),
      },
    });
    realtimeCommandPortFor(this as any).createDefaultResponse();
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === CREATE_RESERVATION && event.arguments) {
      try {
        const parsed = JSON.parse(event.arguments) as Record<string, unknown>;
        const rawStartsAt = typeof parsed.starts_at === "string" ? parsed.starts_at.trim() : null;
        if (rawStartsAt) {
          const normalizedStartsAt = hasExplicitZone(rawStartsAt) ? rawStartsAt : normalizeMadridLocalIso(rawStartsAt);
          if (normalizedStartsAt !== rawStartsAt) {
            (this as any).diagnostics?.checkpoint?.("RESERVATION_DATETIME_NORMALIZED_V20", {
              source_timezone: RESTAURANT_TIMEZONE,
              original_starts_at: rawStartsAt,
              normalized_starts_at: normalizedStartsAt,
            });
          }

          const temporalDecision = decideReservationDatetimeValidity(normalizedStartsAt, Date.now());
          if (temporalDecision.kind !== "ALLOW") {
            (this as any).diagnostics?.checkpoint?.("RESERVATION_DATETIME_REJECTED_V20", {
              reason: temporalDecision.reason,
              original_starts_at: rawStartsAt,
              normalized_starts_at: normalizedStartsAt,
              availability_checked: false,
              confirmation_reached: false,
            });
            this.rejectReservationDatetimeV20(event, temporalDecision.reason, normalizedStartsAt);
            return;
          }

          if (normalizedStartsAt !== rawStartsAt) {
            parsed.starts_at = normalizedStartsAt;
            const normalizedEvent = { ...event, arguments: JSON.stringify(parsed) };
            await BasePrototype.handleRealtimeMessage.call(this, JSON.stringify(normalizedEvent));
            return;
          }
        }
      } catch (error) {
        (this as any).diagnostics?.fail?.("RESERVATION_DATETIME_NORMALIZATION_FAILED_V20", "RESERVATION_DATETIME_INVALID", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
