import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availabilityKey,
  completeReservationFingerprint,
  mergeReservationDraft,
  missingReservationAvailability,
  missingReservationContact,
  nearbyStartTimes,
  parseReservationTurn,
} from "../.test-dist/reservation-orchestrator.js";

test("classifier reservation payload is parsed without persisting confirmation", () => {
  const turn = parseReservationTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "reserva",
    reservation: {
      party_size: 4,
      starts_at: "2026-08-15T21:00:00+02:00",
      customer_name: "Juan",
      use_caller_phone: true,
      confirm: true,
    },
  }));
  assert.equal(turn.patch.partySize, 4);
  assert.equal(turn.patch.startsAt, "2026-08-15T19:00:00.000Z");
  assert.equal(turn.patch.customerName, "Juan");
  assert.equal(turn.confirm, true);
});

test("draft accumulates fields over several voice turns", () => {
  let draft = mergeReservationDraft({}, { partySize: 4 });
  draft = mergeReservationDraft(draft, { startsAt: "2026-08-15T19:00:00.000Z" });
  draft = mergeReservationDraft(draft, { customerName: "Juan", useCallerPhone: true }, "+34600111222");
  assert.deepEqual(missingReservationAvailability(draft), []);
  assert.deepEqual(missingReservationContact(draft), []);
  assert.equal(draft.customerPhone, "+34600111222");
  assert.ok(completeReservationFingerprint(draft));
});

test("availability key changes when requested slot changes", () => {
  const first = availabilityKey({ partySize: 2, startsAt: "2026-08-15T19:00:00.000Z" });
  const second = availabilityKey({ partySize: 2, startsAt: "2026-08-15T19:30:00.000Z" });
  assert.notEqual(first, second);
});

test("nearby alternatives are ordered by configured offsets", () => {
  assert.deepEqual(nearbyStartTimes("2026-08-15T19:00:00.000Z"), [
    "2026-08-15T18:30:00.000Z",
    "2026-08-15T19:30:00.000Z",
    "2026-08-15T18:00:00.000Z",
    "2026-08-15T20:00:00.000Z",
  ]);
});

test("non reservation classifier output produces empty patch", () => {
  assert.deepEqual(parseReservationTurn(JSON.stringify({ intent: "CONTINUE", data_requirement: "MENU", reason: "menu" })), { patch: {}, confirm: false });
});
