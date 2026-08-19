import test from "node:test";
import assert from "node:assert/strict";
import { decideReservationDateScope } from "../.test-dist/reservation-date-scope-policy.js";

test("first concrete date establishes the active reservation date scope", () => {
  assert.deepEqual(decideReservationDateScope({ activeLocalDate: null, requestedLocalDate: "2026-08-26", pendingChange: null, confirmationToken: null }), { action: "ALLOW_AND_SET", localDate: "2026-08-26" });
});

test("same local date remains allowed while time can change", () => {
  assert.deepEqual(decideReservationDateScope({ activeLocalDate: "2026-08-26", requestedLocalDate: "2026-08-26", pendingChange: null, confirmationToken: null }), { action: "ALLOW", localDate: "2026-08-26" });
});

test("silent date drift is blocked and requires a new caller confirmation turn", () => {
  const decision = decideReservationDateScope({ activeLocalDate: "2026-08-26", requestedLocalDate: "2026-08-25", pendingChange: null, confirmationToken: null });
  assert.equal(decision.action, "REQUIRE_CONFIRMATION");
  if (decision.action !== "REQUIRE_CONFIRMATION") return;
  assert.equal(decision.fromLocalDate, "2026-08-26");
  assert.equal(decision.toLocalDate, "2026-08-25");
});

test("date change is allowed only with the matching pending confirmation token", () => {
  const pendingChange = { fromLocalDate: "2026-08-26", toLocalDate: "2026-08-25", token: "scope-7" };
  assert.deepEqual(decideReservationDateScope({ activeLocalDate: "2026-08-26", requestedLocalDate: "2026-08-25", pendingChange, confirmationToken: "scope-7" }), { action: "ALLOW_CONFIRMED_CHANGE", localDate: "2026-08-25" });
  assert.equal(decideReservationDateScope({ activeLocalDate: "2026-08-26", requestedLocalDate: "2026-08-25", pendingChange, confirmationToken: "wrong" }).action, "REQUIRE_CONFIRMATION");
});

test("a stale token cannot authorize a different target date", () => {
  const pendingChange = { fromLocalDate: "2026-08-26", toLocalDate: "2026-08-25", token: "scope-7" };
  assert.equal(decideReservationDateScope({ activeLocalDate: "2026-08-26", requestedLocalDate: "2026-08-27", pendingChange, confirmationToken: "scope-7" }).action, "REQUIRE_CONFIRMATION");
});
