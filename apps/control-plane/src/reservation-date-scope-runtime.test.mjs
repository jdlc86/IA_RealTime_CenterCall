import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ReservationDateScopeRuntime,
  reservationDateScopeRuntimeFor,
} from "../.test-dist/reservation-date-scope-runtime.js";

test("reservation date scope runtime owns caller-turn epoch and deduplicates transcript items", () => {
  const runtime = new ReservationDateScopeRuntime();
  assert.deepEqual(runtime.observeCallerTranscript("quiero mañana", "item-1"), { observed: true, callerTurnEpoch: 1 });
  assert.deepEqual(runtime.observeCallerTranscript("quiero mañana", "item-1"), { observed: false, callerTurnEpoch: 1 });
  assert.deepEqual(runtime.observeCallerTranscript("mejor pasado", "item-2"), { observed: true, callerTurnEpoch: 2 });
  assert.equal(runtime.snapshot().lastCallerTranscriptItemId, "item-2");
});

test("reservation date scope runtime requires a later caller turn for the exact pending date change", () => {
  const runtime = new ReservationDateScopeRuntime();
  runtime.observeCallerTranscript("el miércoles", "turn-1");
  const first = runtime.decide("2026-08-26");
  assert.deepEqual(first, { action: "ALLOW_AND_SET", localDate: "2026-08-26" });
  if (first.action === "REQUIRE_CONFIRMATION") return;
  runtime.accept(first);

  const blocked = runtime.decide("2026-08-27");
  assert.deepEqual(blocked, {
    action: "REQUIRE_CONFIRMATION",
    fromLocalDate: "2026-08-26",
    toLocalDate: "2026-08-27",
  });
  if (blocked.action !== "REQUIRE_CONFIRMATION") return;
  runtime.stagePendingChange(blocked.fromLocalDate, blocked.toLocalDate);
  assert.equal(runtime.decide("2026-08-27").action, "REQUIRE_CONFIRMATION");

  runtime.observeCallerTranscript("sí, el jueves", "turn-2");
  const confirmed = runtime.decide("2026-08-27");
  assert.deepEqual(confirmed, { action: "ALLOW_CONFIRMED_CHANGE", localDate: "2026-08-27" });
  if (confirmed.action === "REQUIRE_CONFIRMATION") return;
  runtime.accept(confirmed);
  assert.equal(runtime.snapshot().activeLocalDate, "2026-08-27");
  assert.equal(runtime.snapshot().pendingChange, null);
});

test("reservation date scope runtime is stable per session and isolated across sessions", () => {
  const a = {};
  const b = {};
  assert.equal(reservationDateScopeRuntimeFor(a), reservationDateScopeRuntimeFor(a));
  assert.notEqual(reservationDateScopeRuntimeFor(a), reservationDateScopeRuntimeFor(b));
});

test("v50 delegates date continuity state to reservation date scope runtime", async () => {
  const source = await readFile(new URL("./call-session-v50-reservation-date-scope.ts", import.meta.url), "utf8");
  assert.match(source, /reservationDateScopeRuntimeFor/);
  assert.match(source, /state_owner: "reservation_date_scope_runtime"/);
  assert.doesNotMatch(source, /activeReservationLocalDateV50/);
  assert.doesNotMatch(source, /pendingReservationDateChangeV50/);
  assert.doesNotMatch(source, /callerTurnEpochV50/);
  assert.doesNotMatch(source, /lastCallerTranscriptItemIdV50/);
});
