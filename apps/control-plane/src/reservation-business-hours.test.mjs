import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReservationBusinessHours,
  sameBusinessLocalDate,
  endOfBusinessLocalDateExclusive,
} from "../.test-dist/reservation-business-hours.js";

const hours = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  opens_at: "13:00:00",
  closes_at: "23:00:00",
}));

test("Sunday without an active business-hours row is closed", () => {
  const decision = evaluateReservationBusinessHours("2026-08-23T22:00:00+02:00", 90, hours);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "CLOSED_DAY");
  assert.equal(decision.localDate, "2026-08-23");
  assert.deepEqual(decision.windows, []);
});

test("reservation must finish inside the active business-hours window", () => {
  assert.equal(evaluateReservationBusinessHours("2026-08-24T21:00:00+02:00", 90, hours).allowed, true);
  const late = evaluateReservationBusinessHours("2026-08-24T22:00:00+02:00", 90, hours);
  assert.equal(late.allowed, false);
  assert.equal(late.reason, "OUTSIDE_BUSINESS_HOURS");
});

test("automatic alternative search cannot silently cross to the next local date", () => {
  assert.equal(
    sameBusinessLocalDate("2026-08-23T22:00:00+02:00", "2026-08-24T18:00:00+02:00"),
    false,
  );
  const end = endOfBusinessLocalDateExclusive("2026-08-24T18:00:00+02:00");
  assert.equal(end, "2026-08-24T22:00:00.000Z");
});
