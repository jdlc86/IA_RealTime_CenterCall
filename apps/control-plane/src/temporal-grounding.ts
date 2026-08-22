export type MadridTemporalLabel = {
  iso: string;
  calendar_date: string;
  clock_time: string;
  relative_day: "HOY" | "MANANA" | "FECHA_ABSOLUTA";
  spoken_date: string;
};

export type AuthoritativeMadridNowContext = {
  timezone: "Europe/Madrid";
  now_iso: string;
  calendar_date: string;
  clock_time: string;
  weekday: string;
};

const AUTHORITATIVE_NOW_MARKER = "[AUTHORITATIVE_NOW_V48]";

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

function madridOffsetIso(value: Date): string {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): string => dateParts.find((p) => p.type === type)?.value ?? "00";
  const localEpoch = Date.UTC(Number(read("year")), Number(read("month")) - 1, Number(read("day")), Number(read("hour")), Number(read("minute")), Number(read("second")));
  const offsetMinutes = Math.round((localEpoch - value.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absolute / 60)).padStart(2, "0");
  const mm = String(absolute % 60).padStart(2, "0");
  return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}:${read("second")}${sign}${hh}:${mm}`;
}

export function authoritativeMadridNowContext(now: Date = new Date()): AuthoritativeMadridNowContext {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid current time");
  return {
    timezone: "Europe/Madrid",
    now_iso: madridOffsetIso(now),
    calendar_date: new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(now),
    clock_time: new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now),
    weekday: new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      weekday: "long",
    }).format(now),
  };
}

export function authoritativeTemporalPromptContext(now: Date = new Date()): string {
  const context = authoritativeMadridNowContext(now);
  return `CONTEXTO TEMPORAL AUTORITATIVO DEL BACKEND: ${JSON.stringify(context)}. Usa exclusivamente este contexto para interpretar hoy, mañana, pasado mañana, este lunes/domingo y cualquier fecha relativa. Nunca inventes el año ni la fecha actual. Si una petición temporal es ambigua, pide aclaración. Este contexto orienta tu interpretación; las validaciones temporales del backend siguen siendo la autoridad final.`;
}

export function stripAuthoritativeNowContext(instructions: string): string {
  const markerIndex = instructions.indexOf(`\n\n${AUTHORITATIVE_NOW_MARKER}\n`);
  return markerIndex >= 0 ? instructions.slice(0, markerIndex) : instructions;
}

export function withAuthoritativeNowContext(instructions: string, now: Date = new Date()): string {
  const base = stripAuthoritativeNowContext(instructions);
  return `${base}\n\n${AUTHORITATIVE_NOW_MARKER}\n${authoritativeTemporalPromptContext(now)}`;
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

const ISO_WITH_ZONE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})\b/g;

export function extractGroundedTemporalReferences(instruction: string, now: Date = new Date()): MadridTemporalLabel[] {
  const unique = [...new Set(instruction.match(ISO_WITH_ZONE) ?? [])];
  return unique.map((iso) => groundMadridDateTime(iso, now));
}

export function withAuthoritativeTemporalGrounding(instruction: string, now: Date = new Date()): string {
  const references = extractGroundedTemporalReferences(instruction, now);
  if (references.length === 0) return instruction;
  return `${instruction}\n\nREFERENCIA TEMPORAL AUTORITATIVA DEL BACKEND (Europe/Madrid): ${JSON.stringify(references)}. Para cada fecha/hora mencionada usa exclusivamente spoken_date y clock_time de esta referencia. No derives ni cambies por tu cuenta hoy/mañana/ayer. Si relative_day=HOY, nunca digas mañana; si relative_day=MANANA, nunca digas hoy. Conserva también la fecha absoluta para evitar ambigüedad.`;
}
