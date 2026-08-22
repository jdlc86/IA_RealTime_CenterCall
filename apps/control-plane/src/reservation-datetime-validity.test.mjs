import test from "node:test";
import assert from "node:assert/strict";
import { decideReservationDatetimeValidity } from "../.test-dist/reservation-datetime-validity.js";

const NOW = Date.parse("2026-08-17T21:45:00Z");

test("rejects the production incident date from 2023", () => {
  const decision = decideReservationDatetimeValidity("2023-08-21T20:00:00+02:00", NOW);
  assert.equal(decision.kind, "REJECT_PAST");
  assert.equal(decision.reason, "RESERVATION_DATETIME_IN_PAST");
});

test("allows a future reservation instant", () => {
  const decision = decideReservationDatetimeValidity("2026-08-21T20:00:00+02:00", NOW);
  assert.equal(decision.kind, "ALLOW");
});

test("rejects an instant equal to now", () => {
  const decision = decideReservationDatetimeValidity("2026-08-17T21:45:00Z", NOW);
  assert.equal(decision.kind, "REJECT_PAST");
});

test("rejects malformed datetimes", () => {
  const decision = decideReservationDatetimeValidity("not-a-date", NOW);
  assert.equal(decision.kind, "REJECT_INVALID");
});
