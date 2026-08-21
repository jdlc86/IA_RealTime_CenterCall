import test from "node:test";
import assert from "node:assert/strict";
import { ReservationRoutingRuntime } from "../.test-dist/reservation-routing-runtime.js";

const reservation = {
  id: "reservation-1",
  reservation_code: "ABC123",
  starts_at: "2026-08-21T20:00:00+02:00",
  ends_at: "2026-08-21T21:30:00+02:00",
  party_size: 4,
  customer_name: "Ana",
  customer_phone: "+34600000000",
  status: "BOOKED",
};

test("reservation routing runtime owns create and cancellation continuity", () => {
  const runtime = new ReservationRoutingRuntime();
  assert.deepEqual(runtime.snapshot(), { createIntentActive: false, cancellationActive: false });

  runtime.markCreateIntentActive();
  assert.equal(runtime.snapshot().createIntentActive, true);
  runtime.startCancellation([reservation]);
  assert.equal(runtime.snapshot().cancellationActive, true);

  const selected = runtime.selectCancellation([reservation.id], { [reservation.id]: "fingerprint" });
  assert.deepEqual(selected.selectedIds, [reservation.id]);
  selected.selectedIds.length = 0;
  assert.deepEqual(runtime.cancellation()?.selectedIds, [reservation.id], "snapshots cannot mutate runtime state");

  runtime.clearCreateIntent();
  runtime.clearCancellation();
  assert.deepEqual(runtime.snapshot(), { createIntentActive: false, cancellationActive: false });
});
