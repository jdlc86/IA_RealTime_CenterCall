export type AuthoritativeRelativeDateDecision =
  | Readonly<{ kind: "NO_RELATIVE_DATE_EVIDENCE" }>
  | Readonly<{ kind: "RESOLVED"; localDate: string; evidence: readonly string[] }>
  | Readonly<{ kind: "AMBIGUOUS"; localDates: readonly string[]; evidence: readonly string[] }>;

export type AuthoritativeRelativeDateRangeDecision =
  | Readonly<{ kind: "NO_RELATIVE_DATE_RANGE_EVIDENCE" }>
  | Readonly<{ kind: "RESOLVED"; fromLocalDate: string; toLocalDateExclusive: string; evidence: readonly string[] }>
  | Readonly<{ kind: "UNPROVEN_RELATIVE_DATE_RANGE"; localDates: readonly string[]; evidence: readonly string[] }>;

const MADRID_TIMEZONE = "Europe/Madrid";
const WEEKDAY_BY_NAME: Readonly<Record<string, number>> = Object.freeze({
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
});
const DAY_COUNT_BY_WORD: Readonly<Record<string, number>> = Object.freeze({
  un: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
});

function normalizedSpanish(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-ES")
    .replace(/\s+/g, " ")
    .trim();
}

function madridLocalDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid authoritative current time");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MADRID_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "00";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function localWeekday(localDate: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function localDayOrdinal(localDate: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function record(
  candidates: Map<string, Set<string>>,
  localDate: string,
  evidence: string,
): void {
  const existing = candidates.get(localDate) ?? new Set<string>();
  existing.add(evidence);
  candidates.set(localDate, existing);
}

/**
 * Resolves the bounded relative-date language that can safely authorize a
 * materialized reservation date. The clock is backend-owned and calendar
 * arithmetic happens on the Europe/Madrid local date, so midnight and DST do
 * not inherit a stale model snapshot.
 *
 * This function deliberately returns no evidence for language it cannot prove.
 * Callers decide whether an already-authorized date may be reused or whether the
 * operation must stop and ask for an explicit date.
 */
export function resolveAuthoritativeRelativeDate(
  callerTranscript: string,
  now: Date = new Date(),
): AuthoritativeRelativeDateDecision {
  const transcript = normalizedSpanish(callerTranscript);
  if (!transcript) return { kind: "NO_RELATIVE_DATE_EVIDENCE" };

  const currentLocalDate = madridLocalDate(now);
  const candidates = new Map<string, Set<string>>();
  let remaining = transcript;

  if (/\bpasado manana\b/.test(remaining)) {
    record(candidates, addLocalDays(currentLocalDate, 2), "pasado mañana");
    remaining = remaining.replace(/\bpasado manana\b/g, " ");
  }

  // Remove uses of "mañana" that mean morning rather than tomorrow.
  const withoutMorningOfDay = remaining
    .replace(/\b(?:por|de) la manana\b/g, " ")
    .replace(/\besta manana\b/g, " ");
  if (/\bmanana\b/.test(withoutMorningOfDay)) {
    record(candidates, addLocalDays(currentLocalDate, 1), "mañana");
  }
  if (/\bhoy\b/.test(remaining)) {
    record(candidates, currentLocalDate, "hoy");
  }

  for (const match of remaining.matchAll(/\b(?:dentro de|en)\s+(\d{1,2}|un|uno|dos|tres|cuatro|cinco|seis|siete)\s+dias?\b/g)) {
    const rawCount = match[1];
    const count = /^\d+$/.test(rawCount) ? Number(rawCount) : DAY_COUNT_BY_WORD[rawCount];
    if (Number.isInteger(count) && count >= 1 && count <= 31) {
      record(candidates, addLocalDays(currentLocalDate, count), match[0]);
    }
  }

  for (const match of remaining.matchAll(/\b(?:(este|proximo)\s+|el\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/g)) {
    const qualifier = match[1] ?? null;
    const targetWeekday = WEEKDAY_BY_NAME[match[2]];
    let dayDelta = (targetWeekday - localWeekday(currentLocalDate) + 7) % 7;
    if (qualifier === "proximo" && dayDelta === 0) dayDelta = 7;
    record(candidates, addLocalDays(currentLocalDate, dayDelta), match[0]);
  }

  if (candidates.size === 0) return { kind: "NO_RELATIVE_DATE_EVIDENCE" };
  const localDates = [...candidates.keys()].sort();
  const evidence = [...new Set([...candidates.values()].flatMap((items) => [...items]))];
  if (localDates.length === 1) {
    return Object.freeze({ kind: "RESOLVED", localDate: localDates[0], evidence: Object.freeze(evidence) });
  }
  return Object.freeze({ kind: "AMBIGUOUS", localDates: Object.freeze(localDates), evidence: Object.freeze(evidence) });
}

export function madridCalendarDate(now: Date = new Date()): string {
  return madridLocalDate(now);
}

/**
 * Resolves only bounded continuous ranges. Discontinuous alternatives remain
 * unproven so a from/to search cannot silently include dates the caller omitted.
 */
export function resolveAuthoritativeRelativeDateRange(
  callerTranscript: string,
  now: Date = new Date(),
): AuthoritativeRelativeDateRangeDecision {
  const transcript = normalizedSpanish(callerTranscript);
  if (!transcript) return { kind: "NO_RELATIVE_DATE_RANGE_EVIDENCE" };
  const currentLocalDate = madridLocalDate(now);
  const currentWeekday = localWeekday(currentLocalDate);

  if (/\b(?:la )?(?:proxima semana|semana (?:que viene|proxima))\b/.test(transcript)) {
    const daysUntilNextMonday = ((8 - currentWeekday) % 7) || 7;
    const fromLocalDate = addLocalDays(currentLocalDate, daysUntilNextMonday);
    return Object.freeze({
      kind: "RESOLVED",
      fromLocalDate,
      toLocalDateExclusive: addLocalDays(fromLocalDate, 7),
      evidence: Object.freeze(["semana que viene"]),
    });
  }

  if (/\besta semana\b/.test(transcript)) {
    const daysUntilMonday = ((8 - currentWeekday) % 7) || 7;
    return Object.freeze({
      kind: "RESOLVED",
      fromLocalDate: currentLocalDate,
      toLocalDateExclusive: addLocalDays(currentLocalDate, daysUntilMonday),
      evidence: Object.freeze(["esta semana"]),
    });
  }

  const nextWeekend = /\b(?:el )?(?:proximo fin de semana|fin de semana que viene)\b/.test(transcript);
  const currentWeekend = /\b(?:este|el) fin de semana\b/.test(transcript);
  if (nextWeekend || currentWeekend) {
    let daysUntilSaturday = (6 - currentWeekday + 7) % 7;
    if (nextWeekend && (currentWeekday === 0 || currentWeekday === 6)) daysUntilSaturday += 7;
    if (currentWeekend && currentWeekday === 0) {
      return Object.freeze({
        kind: "RESOLVED",
        fromLocalDate: currentLocalDate,
        toLocalDateExclusive: addLocalDays(currentLocalDate, 1),
        evidence: Object.freeze(["este fin de semana"]),
      });
    }
    const fromLocalDate = addLocalDays(currentLocalDate, daysUntilSaturday);
    return Object.freeze({
      kind: "RESOLVED",
      fromLocalDate,
      toLocalDateExclusive: addLocalDays(fromLocalDate, 2),
      evidence: Object.freeze([nextWeekend ? "próximo fin de semana" : "este fin de semana"]),
    });
  }

  const individual = resolveAuthoritativeRelativeDate(callerTranscript, now);
  if (individual.kind !== "AMBIGUOUS") return { kind: "NO_RELATIVE_DATE_RANGE_EVIDENCE" };
  const localDates = [...individual.localDates].sort();
  const contiguous = localDayOrdinal(localDates.at(-1)!) - localDayOrdinal(localDates[0]) === localDates.length - 1;
  const continuousConnector = /\b(?:entre|desde|de)\b.+\b(?:y|hasta|a)\b/.test(transcript);
  if (!contiguous && !continuousConnector) {
    return Object.freeze({
      kind: "UNPROVEN_RELATIVE_DATE_RANGE",
      localDates: Object.freeze(localDates),
      evidence: individual.evidence,
    });
  }
  return Object.freeze({
    kind: "RESOLVED",
    fromLocalDate: localDates[0],
    toLocalDateExclusive: addLocalDays(localDates.at(-1)!, 1),
    evidence: individual.evidence,
  });
}
