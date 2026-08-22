const TIMEZONE = "Europe/Madrid";

export type ReservationTimeAuthorityDecision =
  | { action: "ALLOW_EXISTING" }
  | { action: "ALLOW_NEW" }
  | { action: "ALLOW_OFFERED" }
  | { action: "BLOCK"; reason: "TIME_NOT_EXPLICIT_IN_LATEST_CALLER_TURN" | "INVALID_STARTS_AT" };

const HOUR_WORDS: Record<string, number> = {
  una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
};

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9:.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localHourMinute(raw: string): { hour: number; minute: number } | null {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isInteger(hour) && Number.isInteger(minute) ? { hour, minute } : null;
}

function applyDaypart(hour: number, transcript: string): number {
  if (/\bde la manana\b/.test(transcript)) return hour === 12 ? 0 : hour;
  if (/\bde la tarde\b/.test(transcript)) return hour < 12 ? hour + 12 : hour;
  if (/\bde la noche\b/.test(transcript)) {
    if (hour === 12) return 0;
    return hour < 12 ? hour + 12 : hour;
  }
  return hour;
}

function wordMinute(transcript: string): number {
  if (/\bmenos cuarto\b/.test(transcript)) return 45;
  if (/\by cuarto\b/.test(transcript)) return 15;
  if (/\by media\b/.test(transcript)) return 30;
  return 0;
}

export function callerTranscriptSupportsReservationTime(transcriptRaw: string | null | undefined, startsAt: string): boolean {
  if (!transcriptRaw?.trim()) return false;
  const target = localHourMinute(startsAt);
  if (!target) return false;
  const transcript = normalize(transcriptRaw);

  if (target.hour === 12 && target.minute === 0 && /\bmediodia\b/.test(transcript)) return true;
  if (target.hour === 0 && target.minute === 0 && /\bmedianoche\b/.test(transcript)) return true;

  const numeric24 = new RegExp(`(?:^|\\s)(?:a\\s+las\\s+|para\\s+las\\s+|sobre\\s+las\\s+|hacia\\s+las\\s+|a\\s+eso\\s+de\\s+las\\s+)${target.hour}(?:[:.]${String(target.minute).padStart(2, "0")})(?:\\s|$)`);
  if (numeric24.test(transcript)) return true;

  const numericHour = transcript.match(/\b(?:a las|para las|sobre las|hacia las|a eso de las)\s+(\d{1,2})(?:[:.](\d{2}))?\b/);
  if (numericHour) {
    let hour = Number(numericHour[1]);
    const minute = numericHour[2] === undefined ? 0 : Number(numericHour[2]);
    hour = applyDaypart(hour, transcript);
    if (hour === target.hour && minute === target.minute) return true;
  }

  const wordHour = transcript.match(/\b(?:a las|para las|sobre las|hacia las|a eso de las)\s+(una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/);
  if (wordHour) {
    let hour = HOUR_WORDS[wordHour[1]];
    const minute = wordMinute(transcript);
    if (minute === 45 && /\bmenos cuarto\b/.test(transcript)) hour = hour === 1 ? 12 : hour - 1;
    hour = applyDaypart(hour, transcript);
    if (hour === target.hour && minute === target.minute) return true;
  }

  return false;
}

/**
 * Accept semantic interpretation without maintaining a closed grammar of all
 * natural Spanish time expressions. The model must quote the exact evidence it
 * used and the controller proves that quote belongs to the latest caller turn.
 */
export function callerSemanticTimeEvidenceMatchesLatestTurn(
  transcriptRaw: string | null | undefined,
  evidenceRaw: string | null | undefined,
): boolean {
  if (!transcriptRaw?.trim() || !evidenceRaw?.trim()) return false;
  const transcript = normalize(transcriptRaw);
  const evidence = normalize(evidenceRaw);
  return evidence.length > 0 && transcript.includes(evidence);
}

function callerTranscriptSupportsPendingTimeAnswer(transcriptRaw: string | null | undefined, startsAt: string): boolean {
  if (!transcriptRaw?.trim()) return false;
  const target = localHourMinute(startsAt);
  if (!target) return false;
  const transcript = normalize(transcriptRaw);

  // In an explicit TIME collection turn, a concise clock answer is unambiguous.
  // Keep this narrow: party-size/date language cannot satisfy this matcher.
  const clock = transcript.match(/^(?:las\s+)?(\d{1,2})[:.](\d{2})(?:\s+(?:de la manana|de la tarde|de la noche))?$/);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2]);
    hour = applyDaypart(hour, transcript);
    return hour === target.hour && minute === target.minute;
  }

  const numericHour = transcript.match(/^(?:a\s+)?(?:las\s+)?(\d{1,2})(?:\s+(?:de la manana|de la tarde|de la noche))?$/);
  if (numericHour) {
    let hour = Number(numericHour[1]);
    hour = applyDaypart(hour, transcript);
    return hour === target.hour && target.minute === 0;
  }

  const wordHour = transcript.match(/^(?:a\s+)?(?:las\s+)?(una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:\s+(?:de la manana|de la tarde|de la noche))?$/);
  if (wordHour) {
    let hour = HOUR_WORDS[wordHour[1]];
    hour = applyDaypart(hour, transcript);
    return hour === target.hour && target.minute === 0;
  }

  return false;
}

export function decideReservationTimeAuthority(input: {
  requestedStartsAt: string;
  latestCallerTranscript: string | null;
  authorizedStartsAt: string | null;
  pendingSlot?: string | null;
  matchesBackendOfferedSlot?: boolean;
  semanticEvidenceMatchesLatestTurn?: boolean;
}): ReservationTimeAuthorityDecision {
  if (!localHourMinute(input.requestedStartsAt)) return { action: "BLOCK", reason: "INVALID_STARTS_AT" };
  if (input.authorizedStartsAt === input.requestedStartsAt) return { action: "ALLOW_EXISTING" };
  if (input.matchesBackendOfferedSlot === true) return { action: "ALLOW_OFFERED" };
  if (input.semanticEvidenceMatchesLatestTurn === true) return { action: "ALLOW_NEW" };
  if (callerTranscriptSupportsReservationTime(input.latestCallerTranscript, input.requestedStartsAt)) return { action: "ALLOW_NEW" };
  if (
    input.pendingSlot === "starts_at_time" &&
    callerTranscriptSupportsPendingTimeAnswer(input.latestCallerTranscript, input.requestedStartsAt)
  ) return { action: "ALLOW_NEW" };
  return { action: "BLOCK", reason: "TIME_NOT_EXPLICIT_IN_LATEST_CALLER_TURN" };
}
