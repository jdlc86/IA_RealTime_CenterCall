import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isReservationAvailabilityConflict,
  reservationAvailabilityChangedOutput,
} from "../.test-dist/reservation-concurrency-policy.js";

function failed(message) {
  return {
    ok: false,
    tool: "manage_reservation",
    tenantId: "restaurante-centro",
    error: "EXECUTION_FAILED",
    message,
  };
}

test("reservation concurrency: commit-time no_availability is a business conflict", () => {
  assert.equal(isReservationAvailabilityConflict(failed("Supabase RPC create_restaurant_reservation failed: no_availability")), true);
  assert.equal(isReservationAvailabilityConflict(failed("Supabase RPC create_restaurant_reservation_multi failed: no_multitable_availability")), true);
});

test("reservation concurrency: exclusion violation from the booking allocation boundary is a business conflict", () => {
  assert.equal(isReservationAvailabilityConflict(failed('{"code":"23P01","message":"conflicting key value violates exclusion constraint"}')), true);
});

test("reservation concurrency: unrelated backend failures remain technical errors", () => {
  assert.equal(isReservationAvailabilityConflict(failed("Supabase RPC failed with HTTP 503")), false);
  assert.equal(isReservationAvailabilityConflict({ ok: true, tool: "manage_reservation", tenantId: "restaurante-centro", access: "WRITE", result: { stage: "BOOKED" } }), false);
});

test("reservation concurrency: losing the slot is non-terminal and requires fresh confirmation", () => {
  const output = reservationAvailabilityChangedOutput({
    party_size: 4,
    starts_at: "2026-08-20T21:00:00+02:00",
    customer_name: "Ana",
    duration_minutes: 90,
  });
  assert.equal(output.ok, true);
  assert.equal(output.status, "AVAILABILITY_CHANGED");
  assert.equal(output.stage, "AVAILABILITY_CHANGED");
  assert.equal(output.reservation_created, false);
  assert.equal(output.requires_new_confirmation, true);
  assert.equal(output.retryable, true);
  assert.match(String(output.instruction), /no se creó ninguna reserva/i);
  assert.match(String(output.instruction), /nueva confirmación explícita/i);
});
