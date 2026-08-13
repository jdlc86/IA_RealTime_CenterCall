import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReservationTruthClaim } from "../.test-dist/reservation-truth.js";

test("booking confirmation is classified as BOOKED", () => {
  assert.equal(classifyReservationTruthClaim("La reserva ya está confirmada."), "BOOKED");
});

test("cancellation confirmation is classified as CANCELLED, never BOOKED", () => {
  assert.equal(classifyReservationTruthClaim("La reserva ha sido cancelada."), "CANCELLED");
  assert.notEqual(classifyReservationTruthClaim("La reserva ha sido cancelada."), "BOOKED");
});

test("non factual reservation wording has no truth claim", () => {
  assert.equal(classifyReservationTruthClaim("¿Quieres cancelar la reserva?"), null);
});
