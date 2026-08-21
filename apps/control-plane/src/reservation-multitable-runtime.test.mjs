import test from "node:test";
import assert from "node:assert/strict";
import { ReservationMultitableRuntime } from "../.test-dist/reservation-multitable-runtime.js";

const plan = [{
  allocation_mode: "MULTI_EXACT",
  plan_order: 1,
  table_id: "table-1",
  table_code: "T1",
  table_name: "Mesa 1",
  min_capacity: 2,
  max_capacity: 4,
  starts_at: "2026-08-21T20:00:00+02:00",
  ends_at: "2026-08-21T21:30:00+02:00",
}];

test("multi-table runtime owns preferences and defensive plan snapshots", () => {
  const runtime = new ReservationMultitableRuntime();
  runtime.capturePreferences({ separateTablesAcceptable: true, tablesMustBeClose: false });
  runtime.recordPlan(plan, "plan-key");

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.separateTablesAcceptable, true);
  assert.equal(snapshot.tablesMustBeClose, false);
  assert.equal(snapshot.planKey, "plan-key");
  assert.deepEqual(snapshot.plan, plan);

  snapshot.plan[0].table_name = "mutated";
  assert.equal(runtime.snapshot().plan[0].table_name, "Mesa 1");
  runtime.clearPlan();
  assert.equal(runtime.snapshot().plan, null);
  assert.equal(runtime.snapshot().planKey, null);
});
