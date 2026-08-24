import assert from "node:assert/strict";
import test from "node:test";
import {
  madridCalendarDate,
  resolveAuthoritativeRelativeDate,
} from "../.test-dist/authoritative-relative-date.js";

test("Madrid relative date uses the fresh backend day on both sides of midnight", () => {
  const beforeMidnight = new Date("2026-08-23T21:59:00Z");
  const afterMidnight = new Date("2026-08-23T22:01:00Z");

  assert.equal(madridCalendarDate(beforeMidnight), "2026-08-23");
  assert.equal(madridCalendarDate(afterMidnight), "2026-08-24");
  assert.deepEqual(resolveAuthoritativeRelativeDate("Mañana a las nueve", beforeMidnight), {
    kind: "RESOLVED",
    localDate: "2026-08-24",
    evidence: ["mañana"],
  });
  assert.deepEqual(resolveAuthoritativeRelativeDate("Mañana a las nueve", afterMidnight), {
    kind: "RESOLVED",
    localDate: "2026-08-25",
    evidence: ["mañana"],
  });
});

test("relative date arithmetic remains calendar-correct across Madrid DST changes", () => {
  assert.equal(
    resolveAuthoritativeRelativeDate("pasado mañana", new Date("2026-03-28T23:30:00Z")).localDate,
    "2026-03-31",
  );
  assert.equal(
    resolveAuthoritativeRelativeDate("mañana", new Date("2026-10-24T22:30:00Z")).localDate,
    "2026-10-26",
  );
});

test("morning-of-day language is not confused with tomorrow", () => {
  const now = new Date("2026-08-24T08:00:00Z");
  assert.deepEqual(resolveAuthoritativeRelativeDate("A las nueve de la mañana", now), {
    kind: "NO_RELATIVE_DATE_EVIDENCE",
  });
  assert.deepEqual(resolveAuthoritativeRelativeDate("Mañana por la mañana", now), {
    kind: "RESOLVED",
    localDate: "2026-08-25",
    evidence: ["mañana"],
  });
});

test("bounded day offsets and weekdays resolve from the authoritative Madrid date", () => {
  const monday = new Date("2026-08-24T10:00:00Z");
  assert.equal(resolveAuthoritativeRelativeDate("dentro de tres días", monday).localDate, "2026-08-27");
  assert.equal(resolveAuthoritativeRelativeDate("este viernes", monday).localDate, "2026-08-28");
  assert.equal(resolveAuthoritativeRelativeDate("el lunes", monday).localDate, "2026-08-24");
  assert.equal(resolveAuthoritativeRelativeDate("el próximo lunes", monday).localDate, "2026-08-31");
});

test("conflicting relative dates are ambiguous and unsupported language remains unproven", () => {
  const now = new Date("2026-08-24T10:00:00Z");
  assert.deepEqual(resolveAuthoritativeRelativeDate("hoy o mañana", now), {
    kind: "AMBIGUOUS",
    localDates: ["2026-08-24", "2026-08-25"],
    evidence: ["mañana", "hoy"],
  });
  assert.deepEqual(resolveAuthoritativeRelativeDate("cuando haya una mesa tranquila", now), {
    kind: "NO_RELATIVE_DATE_EVIDENCE",
  });
});
