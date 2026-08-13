export type MadridTemporalLabel = {
  iso: string;
  calendar_date: string;
  clock_time: string;
  relative_day: "HOY" | "MANANA" | "FECHA_ABSOLUTA";
  spoken_date: string;
};

function madridParts(value: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: read("year"), m: read("month"), d: read("day") };
}

function ordinalDay(parts: { y: number; m: number; d: number }): number {
  return Math.floor(Date.UTC(parts.y, parts.m - 1, parts.d) / 86_400_000);
}

export function groundMadridDateTime(iso: string, now: Date = new Date()): MadridTemporalLabel {
  const target = new Date(iso);
  if (!Number.isFinite(target.getTime())) throw new Error("Invalid temporal ISO value");
  const targetDay = madridParts(target);
  const currentDay = madridParts(now);
  const delta = ordinalDay(targetDay) - ordinalDay(currentDay);
  const relative_day: MadridTemporalLabel["relative_day"] = delta === 0 ? "HOY" : delta === 1 ? "MANANA" : "FECHA_ABSOLUTA";
  const calendar_date = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(target);
  const clock_time = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(target);
  const spoken_date = relative_day === "HOY"
    ? `hoy, ${calendar_date}`
    : relative_day === "MANANA"
      ? `mañana, ${calendar_date}`
      : calendar_date;
  return { iso: target.toISOString(), calendar_date, clock_time, relative_day, spoken_date };
}

export function groundedReservationView<T extends { starts_at: string }>(row: T, now: Date = new Date()): T & { temporal: MadridTemporalLabel } {
  return { ...row, temporal: groundMadridDateTime(row.starts_at, now) };
}
