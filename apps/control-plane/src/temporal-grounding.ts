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
