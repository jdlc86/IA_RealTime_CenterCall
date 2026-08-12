import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateReservationFlowArgs,
  missingAvailabilityFields,
  missingContactFields,
  reservationFingerprint,
} from "../.test-dist/reservation-flow.js";

test("reservation flow accepts partial collection state", () => {
  const args = validateReservationFlowArgs({ party_size: 4 });
  assert.equal(args.partySize, 4);
  assert.deepEqual(missingAvailabilityFields(args), ["starts_at"]);
  assert.deepEqual(missingContactFields(args), ["customer_name", "customer_phone"]);
});

test("reservation flow rejects unexpected fields", () => {
  assert.throws(() => validateReservationFlowArgs({ party_size: 2, tenant_id: "other" }), /Unexpected reservation field/);
});

test("reservation fingerprint excludes confirm and is stable", () => {
  const base = validateReservationFlowArgs({
    party_size: 2,
    starts_at: "2026-08-15T20:30:00+02:00",
    customer_name: "Ana",
    customer_phone: "+34600111222",
    confirm: false,
  });
  const confirmed = validateReservationFlowArgs({
    party_size: 2,
    starts_at: "2026-08-15T20:30:00+02:00",
    customer_name: "Ana",
    customer_phone: "+34600111222",
    confirm: true,
  });
  assert.equal(reservationFingerprint(base), reservationFingerprint(confirmed));
});

test("reservation flow validates ranges and confirm type", () => {
  assert.throws(() => validateReservationFlowArgs({ party_size: 0 }), /Invalid party_size/);
  assert.throws(() => validateReservationFlowArgs({ duration_minutes: 10 }), /Invalid duration_minutes/);
  assert.throws(() => validateReservationFlowArgs({ confirm: "yes" }), /Invalid confirm/);
});
