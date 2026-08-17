export type ReservationBusinessHoursRow = {
  weekday: number;
  opens_at: string;
  closes_at: string;
};

export type ReservationBusinessHoursDecision = {
  allowed: boolean;
  reason: "ALLOWED" | "CLOSED_DAY" | "OUTSIDE_BUSINESS_HOURS";
  localDate: string;
  weekday: number;
  requestedLocalTime: string;
  windows: Array<{ opens_at: string; closes_at: string }>;
};

const DEFAULT_TIMEZONE = "Europe/Madrid";

function zonedParts(iso: string, timezone: string): { date: string; weekday: number; minutes: number; time: string } {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid reservation datetime");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayName = pick("weekday");
  const weekday = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[weekdayName];
  if (!Number.isInteger(weekday)) throw new Error("Unable to resolve reservation weekday");
  const hour = Number(pick("hour"));
  const minute = Number(pick("minute"));
  return {
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    weekday,
    minutes: hour * 60 + minute,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function timeMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) throw new Error(`Invalid business-hours time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid business-hours time: ${value}`);
  return hour * 60 + minute;
}

export function businessWindowsForDate(
  startsAt: string,
  rows: ReservationBusinessHoursRow[],
  timezone = DEFAULT_TIMEZONE,
): { localDate: string; weekday: number; requestedLocalTime: string; windows: Array<{ opens_at: string; closes_at: string }> } {
  const local = zonedParts(startsAt, timezone);
  const windows = rows
    .filter((row) => row.weekday === local.weekday)
    .map((row) => ({ opens_at: row.opens_at, closes_at: row.closes_at }));
  return { localDate: local.date, weekday: local.weekday, requestedLocalTime: local.time, windows };
}

export function evaluateReservationBusinessHours(
  startsAt: string,
  durationMinutes: number,
  rows: ReservationBusinessHoursRow[],
  timezone = DEFAULT_TIMEZONE,
): ReservationBusinessHoursDecision {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) throw new Error("Invalid reservation duration");
  const start = new Date(startsAt);
  if (!Number.isFinite(start.getTime())) throw new Error("Invalid reservation datetime");
  const localStart = zonedParts(startsAt, timezone);
  const windows = rows
    .filter((row) => row.weekday === localStart.weekday)
    .map((row) => ({ opens_at: row.opens_at, closes_at: row.closes_at }));

  if (!windows.length) {
    return {
      allowed: false,
      reason: "CLOSED_DAY",
      localDate: localStart.date,
      weekday: localStart.weekday,
      requestedLocalTime: localStart.time,
      windows,
    };
  }

  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const localEnd = zonedParts(end.toISOString(), timezone);
  const allowed = localEnd.date === localStart.date && windows.some((window) => {
    const open = timeMinutes(window.opens_at);
    const close = timeMinutes(window.closes_at);
    return localStart.minutes >= open && localEnd.minutes <= close;
  });

  return {
    allowed,
    reason: allowed ? "ALLOWED" : "OUTSIDE_BUSINESS_HOURS",
    localDate: localStart.date,
    weekday: localStart.weekday,
    requestedLocalTime: localStart.time,
    windows,
  };
}

export function sameBusinessLocalDate(a: string, b: string, timezone = DEFAULT_TIMEZONE): boolean {
  return zonedParts(a, timezone).date === zonedParts(b, timezone).date;
}

export function endOfBusinessLocalDateExclusive(anchor: string, timezone = DEFAULT_TIMEZONE): string {
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) throw new Error("Invalid search start");
  const targetDate = zonedParts(anchor, timezone).date;
  let lo = anchorMs;
  let hi = anchorMs + 36 * 60 * 60 * 1000;
  while (zonedParts(new Date(hi).toISOString(), timezone).date === targetDate) hi += 12 * 60 * 60 * 1000;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (zonedParts(new Date(mid).toISOString(), timezone).date === targetDate) lo = mid;
    else hi = mid;
  }
  return new Date(hi).toISOString();
}
