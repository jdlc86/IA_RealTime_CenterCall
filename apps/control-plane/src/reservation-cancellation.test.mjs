import assert from "node:assert/strict";
import { test } from "node:test";
import { cancellationFingerprint, chooseCancellationCandidates, publicCancellationOptions, publicSelectedReservations } from "../.test-dist/reservation-cancellation.js";

const candidates = [
  { id: "11111111-1111-1111-1111-111111111111", reservation_code: "R-100201", starts_at: "2026-08-13T17:00:00.000Z", ends_at: "2026-08-13T18:30:00.000Z", party_size: 2, customer_name: "Juan", customer_phone: "+34600111222", status: "BOOKED" },
  { id: "22222222-2222-2222-2222-222222222222", reservation_code: "R-100202", starts_at: "2026-08-13T19:00:00.000Z", ends_at: "2026-08-13T20:30:00.000Z", party_size: 4, customer_name: "Juan", customer_phone: "+34600111222", status: "BOOKED" },
  { id: "33333333-3333-3333-3333-333333333333", reservation_code: "R-100203", starts_at: "2026-08-13T21:00:00.000Z", ends_at: "2026-08-13T22:30:00.000Z", party_size: 3, customer_name: "Juan", customer_phone: "+34600111222", status: "BOOKED" },
];

const baseTurn = { operation: "CANCEL", patch: {}, confirm: false };

test("single candidate can be selected without reconstructing reservation data", () => {
  assert.equal(chooseCancellationCandidates([candidates[0]], baseTurn)[0]?.id, candidates[0].id);
});

test("multiple candidates require an explicit selection", () => {
  assert.deepEqual(chooseCancellationCandidates(candidates, baseTurn), []);
  assert.deepEqual(chooseCancellationCandidates(candidates, { ...baseTurn, selectionIndex: 2 }).map((item) => item.id), [candidates[1].id]);
});

test("multiple numbered reservations can be selected together", () => {
  assert.deepEqual(chooseCancellationCandidates(candidates, { ...baseTurn, selectionIndexes: [1, 3] }).map((item) => item.id), [candidates[0].id, candidates[2].id]);
});

test("all reservations can be selected explicitly", () => {
  assert.deepEqual(chooseCancellationCandidates(candidates, { ...baseTurn, selectAll: true }).map((item) => item.id), candidates.map((item) => item.id));
});

test("public cancellation views expose friendly codes but never phone or internal id", () => {
  const options = publicCancellationOptions(candidates);
  const selected = publicSelectedReservations([candidates[0], candidates[2]]);
  assert.ok(options.every((option) => !("id" in option) && !("customer_phone" in option)));
  assert.deepEqual(options.map((option) => option.reservation_code), ["R-100201", "R-100202", "R-100203"]);
  assert.deepEqual(selected.map((option) => option.reservation_code), ["R-100201", "R-100203"]);
});

test("confirmation fingerprint changes if reservation state changes", () => {
  const before = cancellationFingerprint(candidates[0]);
  const after = cancellationFingerprint({ ...candidates[0], status: "CANCELLED" });
  assert.notEqual(before, after);
});
