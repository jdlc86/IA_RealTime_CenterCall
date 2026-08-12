import assert from "node:assert/strict";
import { test } from "node:test";
import { cancellationFingerprint, chooseCancellationCandidate, publicCancellationOptions } from "../.test-dist/reservation-cancellation.js";

const candidates = [
  { id: "11111111-1111-1111-1111-111111111111", starts_at: "2026-08-13T17:00:00.000Z", ends_at: "2026-08-13T18:30:00.000Z", party_size: 2, customer_name: "Juan", customer_phone: "+34600111222", status: "BOOKED" },
  { id: "22222222-2222-2222-2222-222222222222", starts_at: "2026-08-13T19:00:00.000Z", ends_at: "2026-08-13T20:30:00.000Z", party_size: 4, customer_name: "Juan", customer_phone: "+34600111222", status: "BOOKED" },
];

test("single candidate can be selected without asking user to reconstruct reservation data", () => {
  assert.equal(chooseCancellationCandidate([candidates[0]], { operation: "CANCEL", patch: {}, confirm: false })?.id, candidates[0].id);
});

test("multiple candidates require an explicit numbered selection", () => {
  assert.equal(chooseCancellationCandidate(candidates, { operation: "CANCEL", patch: {}, confirm: false }), null);
  assert.equal(chooseCancellationCandidate(candidates, { operation: "CANCEL", patch: {}, confirm: false, selectionIndex: 2 })?.id, candidates[1].id);
});

test("public options never expose phone or internal reservation id", () => {
  assert.deepEqual(publicCancellationOptions(candidates), [
    { option: 1, starts_at: candidates[0].starts_at, party_size: 2, customer_name: "Juan" },
    { option: 2, starts_at: candidates[1].starts_at, party_size: 4, customer_name: "Juan" },
  ]);
});

test("confirmation fingerprint changes if reservation state changes", () => {
  const before = cancellationFingerprint(candidates[0]);
  const after = cancellationFingerprint({ ...candidates[0], status: "CANCELLED" });
  assert.notEqual(before, after);
});
