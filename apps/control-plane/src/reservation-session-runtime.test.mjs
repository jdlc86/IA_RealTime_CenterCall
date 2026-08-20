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

test("availability conflict invalidates confirmation but preserves reservation facts", () => {
  const runtime = new ReservationSessionRuntime();
  runtime.mergeDraft({ party_size: 2, starts_at: "2026-09-25T20:00:00+02:00", confirm: true }, null);
  runtime.invalidateAvailabilityForConflict();
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.stage, "CONFLICT");
  assert.equal(snapshot.draft.confirm, false);
  assert.equal(snapshot.draft.party_size, 2);
  assert.equal(snapshot.draft.starts_at, "2026-09-25T20:00:00+02:00");
});
