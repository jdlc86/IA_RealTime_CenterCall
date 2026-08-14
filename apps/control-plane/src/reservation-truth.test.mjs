import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeReservationClaim } from "../.test-dist/reservation-truth.js";

test("create BOOKED evidence authorizes created and booked claims", () => {
  const evidence = { source: "CREATE_RESULT", status: "BOOKED" };
  assert.deepEqual(authorizeReservationClaim("RESERVATION_CREATED", evidence), { allowed: true, reason: "EVIDENCE_MATCH" });
  assert.deepEqual(authorizeReservationClaim("RESERVATION_IS_BOOKED", evidence), { allowed: true, reason: "EVIDENCE_MATCH" });
});

test("query BOOKED evidence authorizes existing booked status but not creation", () => {
  const evidence = { source: "QUERY_RESULT", status: "BOOKED" };
  assert.deepEqual(authorizeReservationClaim("RESERVATION_IS_BOOKED", evidence), { allowed: true, reason: "EVIDENCE_MATCH" });
  assert.deepEqual(authorizeReservationClaim("RESERVATION_CREATED", evidence), { allowed: false, reason: "EVIDENCE_MISMATCH" });
});

test("cancel evidence authorizes only cancellation", () => {
  const evidence = { source: "CANCEL_RESULT", status: "CANCELLED" };
  assert.deepEqual(authorizeReservationClaim("RESERVATION_CANCELLED", evidence), { allowed: true, reason: "EVIDENCE_MATCH" });
  assert.deepEqual(authorizeReservationClaim("RESERVATION_IS_BOOKED", evidence), { allowed: false, reason: "EVIDENCE_MISMATCH" });
});

test("claims without backend evidence fail closed", () => {
  assert.deepEqual(authorizeReservationClaim("RESERVATION_IS_BOOKED", null), { allowed: false, reason: "EVIDENCE_MISSING" });
});
