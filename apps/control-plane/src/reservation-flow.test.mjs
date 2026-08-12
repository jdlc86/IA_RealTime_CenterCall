import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateReservationFlowArgs,
  missingAvailabilityFields,
  missingContactFields,
  reservationFingerprint,
  resolveReservationContactPhone,
  withResolvedReservationContact,
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

test("reservation can use inbound caller number after explicit agreement", () => {
  const args = validateReservationFlowArgs({
    party_size: 2,
    starts_at: "2026-08-15T20:30:00+02:00",
    customer_name: "Ana",
    use_caller_phone: true,
  });
  const resolved = withResolvedReservationContact(args, "+34600111222");
  assert.equal(resolved.customerPhone, "+34600111222");
  assert.deepEqual(missingContactFields(resolved), []);
});

test("use caller phone fails closed when inbound caller number is unavailable", () => {
  const args = validateReservationFlowArgs({ use_caller_phone: true });
  assert.equal(resolveReservationContactPhone(args, null), undefined);
});

test("explicit different reservation phone remains allowed", () => {
  const args = validateReservationFlowArgs({ customer_phone: "+34600999888" });
  assert.equal(resolveReservationContactPhone(args, "+34600111222"), "+34600999888");
});

test("conflicting explicit phone and use-caller selection is rejected", () => {
  const args = validateReservationFlowArgs({ customer_phone: "+34600999888", use_caller_phone: true });
  assert.throws(() => resolveReservationContactPhone(args, "+34600111222"), /Conflicting reservation phone selection/);
});

test("reservation flow validates E.164 ranges and boolean fields", () => {
  assert.throws(() => validateReservationFlowArgs({ party_size: 0 }), /Invalid party_size/);
  assert.throws(() => validateReservationFlowArgs({ duration_minutes: 10 }), /Invalid duration_minutes/);
  assert.throws(() => validateReservationFlowArgs({ confirm: "yes" }), /Invalid confirm/);
  assert.throws(() => validateReservationFlowArgs({ use_caller_phone: "yes" }), /Invalid use_caller_phone/);
  assert.throws(() => validateReservationFlowArgs({ customer_phone: "600111222" }), /Invalid customer_phone/);
});
