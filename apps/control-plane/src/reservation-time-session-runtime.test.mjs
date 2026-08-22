import test from "node:test";
import assert from "node:assert/strict";
import { ReservationTimeSessionRuntime } from "../.test-dist/reservation-time-session-runtime.js";

test("an offered slot requires a subsequent caller turn before it can be selected", () => {
  const runtime = new ReservationTimeSessionRuntime();
  runtime.observeCallerTurn("Buscad para diez personas");
  runtime.recordOfferedSlots(["2026-08-26T11:00:00+00:00"]);

  assert.equal(runtime.matchesOfferedSlotAfterCallerTurn("2026-08-26T13:00:00+02:00"), false);
  runtime.observeCallerTurn("La primera opción");
  assert.equal(runtime.matchesOfferedSlotAfterCallerTurn("2026-08-26T13:00:00+02:00"), true);
});

test("only an exact offered instant is accepted and commit consumption clears offers", () => {
  const runtime = new ReservationTimeSessionRuntime();
  runtime.recordOfferedSlots(["2026-08-26T11:00:00+00:00"]);
  runtime.observeCallerTurn("Prefiero esa");

  assert.equal(runtime.matchesOfferedSlotAfterCallerTurn("2026-08-26T13:30:00+02:00"), false);
  runtime.consume("restaurant_reservation_create");
  runtime.observeCallerTurn("Sí");
  assert.equal(runtime.matchesOfferedSlotAfterCallerTurn("2026-08-26T13:00:00+02:00"), false);
});
