import assert from "node:assert/strict";
import test from "node:test";
import { createProductOwnedAuthoritativeTemporalContextCapability } from "../.test-dist/authoritative-temporal-context-port.js";
import {
  installAuthoritativeTemporalContextPort,
  removeAuthoritativeTemporalContextPort,
} from "../.test-dist/authoritative-temporal-context-runtime.js";
import { enforceReservationRelativeDateAuthority } from "../.test-dist/reservation-relative-date-authority-runtime.js";

test("relative-date authority consumes stale rollover materialization before business execution", () => {
  const sent = [];
  const session = { send: (event) => sent.push(structuredClone(event)) };
  const temporal = createProductOwnedAuthoritativeTemporalContextCapability();
  installAuthoritativeTemporalContextPort(session, temporal.port);
  temporal.port.refresh({
    baseInstructions: "BASE",
    now: new Date("2026-08-23T22:01:00Z"),
    callerTurn: { itemId: "caller-after-rollover", transcript: "mañana a las nueve" },
  });
  let semanticAuthorizations = 0;

  try {
    const outcome = enforceReservationRelativeDateAuthority(session, {
      callId: "reservation-call-1",
      toolName: "restaurant_reservation_create",
      requestedLocalDate: "2026-08-24",
      authorizeSemanticTool() { semanticAuthorizations += 1; return true; },
    });
    assert.equal(outcome.handled, true);
    assert.equal(outcome.decision.action, "BLOCK_MISMATCH");
  } finally {
    removeAuthoritativeTemporalContextPort(session, temporal.port);
    temporal.close();
  }

  assert.equal(semanticAuthorizations, 1);
  const toolOutputEvent = sent.find((event) => event.item?.type === "function_call_output");
  assert.ok(toolOutputEvent, "authoritative date rejection must produce one tool result");
  assert.deepEqual(JSON.parse(toolOutputEvent.item.output), {
    ok: true,
    status: "RELATIVE_DATE_MISMATCH",
    date_authoritative: false,
    requested_local_date: "2026-08-24",
    authoritative_local_date: "2026-08-25",
    authoritative_local_dates: null,
    requires_new_caller_turn: true,
    availability_checked: false,
    reservation_write_attempted: false,
    instruction: "La fecha relativa se materializó con un contexto temporal obsoleto. No consultes disponibilidad ni reserves todavía. Explica la fecha absoluta correcta indicada por authoritative_local_date y pide al cliente que confirme esa fecha concreta en un nuevo turno.",
  });
  assert.equal(sent.filter((event) => event.item?.type === "function_call_output").length, 1);
  assert.equal(sent.some((event) => event.item?.role === "user"), false);
  assert.equal(sent.at(-1)?.type, "response.create");
});

test("fresh or non-relative dates pass without consuming semantic authority or emitting provider effects", () => {
  const sent = [];
  const session = { send: (event) => sent.push(event) };
  const temporal = createProductOwnedAuthoritativeTemporalContextCapability();
  installAuthoritativeTemporalContextPort(session, temporal.port);
  let semanticAuthorizations = 0;

  try {
    temporal.port.refresh({
      baseInstructions: "BASE",
      now: new Date("2026-08-23T22:01:00Z"),
      callerTurn: { itemId: "caller-fresh", transcript: "mañana a las nueve" },
    });
    assert.equal(enforceReservationRelativeDateAuthority(session, {
      toolName: "restaurant_reservation_create",
      requestedLocalDate: "2026-08-25",
      authorizeSemanticTool() { semanticAuthorizations += 1; return true; },
    }).handled, false);

    temporal.port.refresh({
      baseInstructions: "BASE",
      now: new Date("2026-08-23T22:02:00Z"),
      callerTurn: { itemId: "caller-explicit", transcript: "el 28 de agosto a las nueve" },
    });
    assert.equal(enforceReservationRelativeDateAuthority(session, {
      toolName: "restaurant_reservation_create",
      requestedLocalDate: "2026-08-28",
      authorizeSemanticTool() { semanticAuthorizations += 1; return true; },
    }).handled, false);
  } finally {
    removeAuthoritativeTemporalContextPort(session, temporal.port);
    temporal.close();
  }

  assert.equal(semanticAuthorizations, 0);
  assert.deepEqual(sent, []);
});
