import test from "node:test";
import assert from "node:assert/strict";
import { decideReservationDateScope } from "../.test-dist/reservation-date-scope-policy.js";

test("first concrete date establishes the active reservation date scope", () => {
  assert.deepEqual(decideReservationDateScope({ activeLocalDate: null, requestedLocalDate: "2026-08-26", pendingChange: null, currentCallerTurnEpoch: 3 }), { action: "ALLOW_AND_SET", localDate: "2026-08-26" });
});

test("same local date remains allowed while time can change", () => {
  assert.deepEqual(decideReservationDateScope({ activeLocalDate: "2026-08-26", requestedLocalDate: "2026-08-26", pendingChange: null, currentCallerTurnEpoch: 4 }), { action: "ALLOW", localDate: "2026-08-26" });
});

test("silent date drift is blocked in the same caller turn", () => {
  const pendingChange = { fromLocalDate: "2026-08-26", toLocalDate: "2026-08-25", requestedAtCallerTurnEpoch: 7 };
  const decision = decideReservationDateScope({ activeLocalDate: "2026-08-26", requestedLocalDate: "2026-08-25", pendingChange, currentCallerTurnEpoch: 7 });
  assert.equal(decision.action, "REQUIRE_CONFIRMATION");
  if (decision.action !== "REQUIRE_CONFIRMATION") return;
  assert.equal(decision.fromLocalDate, "2026-08-26");
  assert.equal(decision.toLocalDate, "2026-08-25");
});

test("exact date change is allowed only after a later caller transcript", () => {
  const pendingChange = { fromLocalDate: "2026-08-26", toLocalDate: "2026-08-25", requestedAtCallerTurnEpoch: 7 };
  assert.deepEqual(decideReservationDateScope({ activeLocalDate: "2026-08-26", requestedLocalDate: "2026-08-25", pendingChange, currentCallerTurnEpoch: 8 }), { action: "ALLOW_CONFIRMED_CHANGE", localDate: "2026-08-25" });
});

test("a later caller turn cannot authorize a different target date", () => {
  const pendingChange = { fromLocalDate: "2026-08-26", toLocalDate: "2026-08-25", requestedAtCallerTurnEpoch: 7 };
  assert.equal(decideReservationDateScope({ activeLocalDate: "2026-08-26", requestedLocalDate: "2026-08-27", pendingChange, currentCallerTurnEpoch: 8 }).action, "REQUIRE_CONFIRMATION");
});
