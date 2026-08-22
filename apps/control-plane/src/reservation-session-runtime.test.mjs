import test from "node:test";
import assert from "node:assert/strict";
import { ReservationSessionRuntime } from "../.test-dist/reservation-session-runtime.js";

test("reservation session runtime is the single draft and commit owner", () => {
  const runtime = new ReservationSessionRuntime();
  const draft = runtime.mergeDraft({ party_size: 5, starts_at: "2026-08-21T14:00:00+02:00" }, "+34600000000");
  assert.equal(draft.party_size, 5);
  assert.equal(runtime.snapshot().stage, "COLLECTING");
  const before = runtime.snapshot().commitEpoch;
  runtime.markNeedsContact();
  assert.equal(runtime.committedAfter(before), false);
  runtime.mergeDraft({ customer_name: "Juan", use_caller_phone: true }, "+34600000000");
  assert.equal(runtime.snapshot().draft.customer_phone, "+34600000000");
  runtime.markBooked();
  assert.equal(runtime.committedAfter(before), true);
  assert.equal(runtime.snapshot().stage, "BOOKED");
  assert.deepEqual(runtime.snapshot().draft, {});
});

test("multi-table preferences are owned with the reservation draft", () => {
  const runtime = new ReservationSessionRuntime();
  runtime.mergeDraft({
    party_size: 5,
    starts_at: "2026-08-21T14:00:00+02:00",
    separate_tables_acceptable: false,
    tables_must_be_close: true,
  }, null);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.draft.party_size, 5);
  assert.equal(snapshot.draft.separate_tables_acceptable, false);
  assert.equal(snapshot.draft.tables_must_be_close, true);
});

test("availability conflict invalidates confirmation but preserves reservation facts", () => {
  const runtime = new ReservationSessionRuntime();
  runtime.mergeDraft({ party_size: 2, starts_at: "2026-09-25T20:00:00+02:00", confirm: true }, null);
  runtime.invalidateAvailabilityForConflict();
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.stage, "CONFLICT");
  assert.equal(snapshot.draft.confirm, false);
  assert.equal(snapshot.draft.party_size, 2);
  assert.equal(snapshot.draft.starts_at, "2026-09-25T20:00:00+02:00");
  assert.equal(snapshot.offeredSlotFingerprint, null);
});

test("a semantic confirmation accepts the only outstanding multi-table proposal", () => {
  const runtime = new ReservationSessionRuntime();
  const draft = runtime.mergeDraft({
    party_size: 15,
    starts_at: "2026-08-22T21:00:00+02:00",
  }, null);
  runtime.recordAvailability(runtime.fingerprintFor(draft), {
    requested_available: false,
    requested_candidates: [{ table_code: "T1" }, { table_code: "T2" }],
  });

  assert.deepEqual(runtime.canonicalizeOutstandingConfirmation({ confirm: true }), {
    confirm: true,
    separate_tables_acceptable: true,
  });
  assert.equal(runtime.wasSlotOffered(draft), true);
});

test("outstanding confirmation never overrides explicit table preferences", () => {
  const runtime = new ReservationSessionRuntime();
  const draft = runtime.mergeDraft({
    party_size: 15,
    starts_at: "2026-08-22T21:00:00+02:00",
  }, null);
  runtime.recordAvailability(runtime.fingerprintFor(draft), {
    requested_available: false,
    requested_candidates: [{ table_code: "T1" }, { table_code: "T2" }],
  });

  assert.deepEqual(
    runtime.canonicalizeOutstandingConfirmation({ confirm: true, separate_tables_acceptable: false }),
    { confirm: true, separate_tables_acceptable: false },
  );
  runtime.mergeDraft({ tables_must_be_close: true }, null);
  assert.deepEqual(runtime.canonicalizeOutstandingConfirmation({ confirm: true }), { confirm: true });
});

test("an unavailable recheck is recognized only for the exact previously offered slot", () => {
  const runtime = new ReservationSessionRuntime();
  const offered = runtime.mergeDraft({
    party_size: 15,
    starts_at: "2026-08-22T21:00:00+02:00",
  }, null);
  runtime.recordAvailability(runtime.fingerprintFor(offered), {
    requested_available: true,
    requested_candidates: [{ table_code: "T1" }],
  });

  assert.equal(runtime.wasSlotOffered(offered), true);
  assert.equal(runtime.wasSlotOffered({ ...offered, starts_at: "2026-08-22T22:00:00+02:00" }), false);
  assert.equal(runtime.wasSlotOffered({ ...offered, party_size: 14 }), false);
});
