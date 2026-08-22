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

test("classifier reservation payload defaults to CREATE without changing legacy behavior", () => {
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
  assert.equal(turn.operation, "CREATE");
  assert.equal(turn.patch.partySize, 4);
  assert.equal(turn.patch.startsAt, "2026-08-15T19:00:00.000Z");
  assert.equal(turn.customerName, undefined);
  assert.equal(turn.patch.customerName, "Juan");
  assert.equal(turn.confirm, true);
  assert.equal(turn.unresolvedStartsAt, false);
});

test("unresolved natural datetime does not invalidate the whole reservation turn", () => {
  const turn = parseReservationTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "usuario sigue concretando la fecha",
    reservation: {
      party_size: 2,
      starts_at: "mañana a las nueve",
      customer_name: "Juan",
    },
  }));
  assert.equal(turn.operation, "CREATE");
  assert.equal(turn.patch.partySize, 2);
  assert.equal(turn.patch.customerName, "Juan");
  assert.equal(turn.patch.startsAt, undefined);
  assert.equal(turn.unresolvedStartsAt, true);
  assert.deepEqual(missingReservationAvailability(turn.patch), ["starts_at"]);
});

test("classifier can express QUERY without requiring creation fields", () => {
  const turn = parseReservationTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "quiere consultar sus reservas",
    reservation: { operation: "QUERY" },
  }));
  assert.equal(turn.operation, "QUERY");
  assert.equal(turn.confirm, false);
});

test("QUERY never accepts a dictated phone as caller identity", () => {
  const turn = parseReservationTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "consulta la reserva de otro número dictado",
    reservation: {
      operation: "QUERY",
      customer_phone: "+93642651015",
      use_caller_phone: false,
    },
  }));
  assert.equal(turn.operation, "QUERY");
  assert.equal(turn.patch.customerPhone, undefined);
  assert.equal(turn.patch.useCallerPhone, undefined);
});

test("classifier can express one CANCEL selection", () => {
  const turn = parseReservationTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "quiere cancelar la segunda reserva",
    reservation: { operation: "CANCEL", selection_index: 2, confirm: false },
  }));
  assert.equal(turn.operation, "CANCEL");
  assert.equal(turn.selectionIndex, 2);
  assert.equal(turn.confirm, false);
});

test("CANCEL never accepts a dictated phone as caller identity", () => {
  const turn = parseReservationTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "cancela la reserva asociada a un número dictado",
    reservation: {
      operation: "CANCEL",
      customer_phone: "+93642651015",
      use_caller_phone: false,
      select_all: true,
      confirm: true,
    },
  }));
  assert.equal(turn.operation, "CANCEL");
  assert.equal(turn.patch.customerPhone, undefined);
  assert.equal(turn.patch.useCallerPhone, undefined);
  assert.equal(turn.selectAll, true);
  assert.equal(turn.confirm, true);
});

test("classifier can express several CANCEL selections", () => {
  const turn = parseReservationTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "quiere cancelar la primera y la tercera",
    reservation: { operation: "CANCEL", selection_indexes: [1, 3], confirm: false },
  }));
  assert.deepEqual(turn.selectionIndexes, [1, 3]);
  assert.equal(turn.selectAll, false);
});

test("classifier can express CANCEL all explicitly", () => {
  const turn = parseReservationTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "quiere cancelar todas",
    reservation: { operation: "CANCEL", select_all: true, confirm: false },
  }));
  assert.equal(turn.selectAll, true);
});

test("conflicting multi-cancel selection modes fail closed", () => {
  assert.throws(() => parseReservationTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "conflict",
    reservation: { operation: "CANCEL", selection_index: 1, select_all: true },
  })));
});

test("draft defaults reservation contact to trusted caller without an extra voice turn", () => {
  const draft = mergeReservationDraft({}, { partySize: 2 }, "+34600111222");
  assert.equal(draft.customerPhone, "+34600111222");
  assert.equal(draft.useCallerPhone, true);
});

test("explicit alternate reservation contact overrides the trusted caller", () => {
  const draft = mergeReservationDraft({}, { customerPhone: "+34600999888" }, "+34600111222");
  assert.equal(draft.customerPhone, "+34600999888");
  assert.equal(draft.useCallerPhone, false);
});

test("untrusted caller format is never copied into reservation contact", () => {
  const draft = mergeReservationDraft({}, { customerName: "Juan" }, "anonymous");
  assert.equal(draft.customerPhone, undefined);
  assert.deepEqual(missingReservationContact(draft), ["customer_phone"]);
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
  assert.deepEqual(nearbyStartTimes("2026-08-15T19:00:00.000Z"), ["2026-08-15T18:30:00.000Z", "2026-08-15T19:30:00.000Z", "2026-08-15T18:00:00.000Z", "2026-08-15T20:00:00.000Z"]);
});

test("non reservation classifier output produces legacy empty CREATE turn", () => {
  assert.deepEqual(parseReservationTurn(JSON.stringify({ intent: "CONTINUE", data_requirement: "MENU", reason: "menu" })), { operation: "CREATE", patch: {}, confirm: false });
});
