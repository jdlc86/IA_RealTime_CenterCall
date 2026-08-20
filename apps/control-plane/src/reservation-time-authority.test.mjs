import test from "node:test";
import assert from "node:assert/strict";
import {
  callerTranscriptSupportsReservationTime,
  decideReservationTimeAuthority,
} from "../.test-dist/reservation-time-authority.js";

test("blocks a materialized reservation hour that caller never said", () => {
  assert.deepEqual(decideReservationTimeAuthority({
    requestedStartsAt: "2026-09-15T22:00:00+02:00",
    latestCallerTranscript: "Quiero reservar el quince para veinticinco personas.",
    authorizedStartsAt: null,
  }), { action: "BLOCK", reason: "TIME_NOT_EXPLICIT_IN_LATEST_CALLER_TURN" });
});

test("accepts natural explicit Spanish time and establishes authority", () => {
  assert.equal(callerTranscriptSupportsReservationTime(
    "Perdona, a las nueve de la noche.",
    "2026-09-15T21:00:00+02:00",
  ), true);
  assert.deepEqual(decideReservationTimeAuthority({
    requestedStartsAt: "2026-09-15T21:00:00+02:00",
    latestCallerTranscript: "Perdona, a las nueve de la noche.",
    authorizedStartsAt: null,
  }), { action: "ALLOW_NEW" });
});

test("authorized time survives a later confirmation turn", () => {
  assert.deepEqual(decideReservationTimeAuthority({
    requestedStartsAt: "2026-09-15T21:00:00+02:00",
    latestCallerTranscript: "Sí, confirmo.",
    authorizedStartsAt: "2026-09-15T21:00:00+02:00",
  }), { action: "ALLOW_EXISTING" });
});

test("changing the hour requires fresh caller evidence", () => {
  assert.deepEqual(decideReservationTimeAuthority({
    requestedStartsAt: "2026-09-15T22:00:00+02:00",
    latestCallerTranscript: "Sí, confirmo.",
    authorizedStartsAt: "2026-09-15T21:00:00+02:00",
  }), { action: "BLOCK", reason: "TIME_NOT_EXPLICIT_IN_LATEST_CALLER_TURN" });
});

test("supports half-hour natural speech without assuming another hour", () => {
  assert.equal(callerTranscriptSupportsReservationTime(
    "A las diez y media de la noche.",
    "2026-09-15T22:30:00+02:00",
  ), true);
  assert.equal(callerTranscriptSupportsReservationTime(
    "A las diez y media de la noche.",
    "2026-09-15T21:30:00+02:00",
  ), false);
});

test("ambiguous twelve-hour phrase cannot authorize an inferred evening hour", () => {
  assert.equal(callerTranscriptSupportsReservationTime(
    "A las nueve.",
    "2026-09-15T21:00:00+02:00",
  ), false);
});

test("bare clock-like token is not enough authority without time-slot context", () => {
  assert.equal(callerTranscriptSupportsReservationTime(
    "16:00",
    "2026-09-15T16:00:00+02:00",
  ), false);
  assert.deepEqual(decideReservationTimeAuthority({
    requestedStartsAt: "2026-09-15T16:00:00+02:00",
    latestCallerTranscript: "16:00",
    authorizedStartsAt: null,
  }), { action: "BLOCK", reason: "TIME_NOT_EXPLICIT_IN_LATEST_CALLER_TURN" });
});

test("explicit clock token with temporal cue remains authoritative", () => {
  assert.equal(callerTranscriptSupportsReservationTime(
    "A las 16:00.",
    "2026-09-15T16:00:00+02:00",
  ), true);
});

test("party-size language cannot authorize a reservation hour", () => {
  assert.equal(callerTranscriptSupportsReservationTime(
    "Somos cuatro personas.",
    "2026-09-15T16:00:00+02:00",
  ), false);
});

test("bare clock answer is authoritative while the explicit pending slot is reservation time", () => {
  assert.deepEqual(decideReservationTimeAuthority({
    requestedStartsAt: "2026-09-15T16:00:00+02:00",
    latestCallerTranscript: "16:00",
    authorizedStartsAt: null,
    pendingSlot: "starts_at_time",
  }), { action: "ALLOW_NEW" });
});

test("numeric party-size answer still cannot authorize time even with time pending", () => {
  assert.deepEqual(decideReservationTimeAuthority({
    requestedStartsAt: "2026-09-15T16:00:00+02:00",
    latestCallerTranscript: "somos cuatro personas",
    authorizedStartsAt: null,
    pendingSlot: "starts_at_time",
  }), { action: "BLOCK", reason: "TIME_NOT_EXPLICIT_IN_LATEST_CALLER_TURN" });
});
