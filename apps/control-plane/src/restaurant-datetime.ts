export const RESTAURANT_TIMEZONE = "Europe/Madrid";

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function hasExplicitZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
}

function parseLocalIso(value: string): LocalDateTimeParts | null {
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

function partsInTimeZone(epochMs: number, timeZone: string): LocalDateTimeParts {
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

function localPartsEpoch(parts: LocalDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

export function normalizeRestaurantLocalIso(value: string, timeZone = RESTAURANT_TIMEZONE): string {
  const trimmed = value.trim();
  if (hasExplicitZone(trimmed)) return trimmed;
  const target = parseLocalIso(trimmed);
  if (!target) return trimmed;

  const targetEpoch = localPartsEpoch(target);
  let candidateUtc = targetEpoch;
  for (let i = 0; i < 3; i += 1) {
    const rendered = partsInTimeZone(candidateUtc, timeZone);
    const deltaMs = localPartsEpoch(rendered) - targetEpoch;
    if (deltaMs === 0) break;
    candidateUtc -= deltaMs;
  }

  const verified = partsInTimeZone(candidateUtc, timeZone);
  if (localPartsEpoch(verified) !== targetEpoch) {
    throw new Error(`La hora local ${trimmed} no existe o es ambigua en ${timeZone}`);
  }

  const offsetMinutes = Math.round((targetEpoch - candidateUtc) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const offsetMins = String(absolute % 60).padStart(2, "0");
  const seconds = String(target.second).padStart(2, "0");
  return `${String(target.year).padStart(4, "0")}-${String(target.month).padStart(2, "0")}-${String(target.day).padStart(2, "0")}T${String(target.hour).padStart(2, "0")}:${String(target.minute).padStart(2, "0")}:${seconds}${sign}${offsetHours}:${offsetMins}`;
}
