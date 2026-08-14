import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyReservationOutputPolicy,
  deriveReservationOutputStage,
  isLegacyReservationContinueOutput,
  rewriteReservationClassifierOutput,
} from "../.test-dist/reservation-output-policy.js";

test("confirmation fingerprint makes READY_TO_CONFIRM authoritative", () => {
  assert.equal(deriveReservationOutputStage({
    booked: false,
    confirmationArmed: true,
    instructions: "Resume los datos y pregunta si confirma.",
  }), "READY_TO_CONFIRM");
});

test("BOOKED always wins over confirmation state", () => {
  assert.equal(deriveReservationOutputStage({
    booked: true,
    confirmationArmed: true,
    instructions: "Reserva confirmada por backend.",
  }), "BOOKED");
});

test("collecting policy forbids premature processing language", () => {
  const governed = applyReservationOutputPolicy("Pregunta a nombre de quién será la reserva.", "COLLECTING");
  assert.match(governed, /Estado backend: COLLECTING/);
  assert.match(governed, /No digas que vas a procesar/);
});

test("READY_TO_CONFIRM policy remains a closed backend-authoritative prompt", () => {
  const governed = applyReservationOutputPolicy("Resume los datos autorizados.", "READY_TO_CONFIRM");
  assert.match(governed, /Estado backend: READY_TO_CONFIRM/);
  assert.match(governed, /pedir una confirmación explícita/);
  assert.doesNotMatch(governed, /INVARIANTE DE DOMINIO Y AUTORIDAD/);
});

test("legacy reservation continue output is deferred and rewritten with backend stage", () => {
  const event = {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({
        ok: true,
        action: "continue",
        data_requirement: "RESERVATION",
        reservation_orchestrator: "backend_v1",
      }),
    },
  };
  assert.equal(isLegacyReservationContinueOutput(event), true);
  const rewritten = rewriteReservationClassifierOutput(event, "READY_TO_CONFIRM");
  const output = JSON.parse(rewritten.item.output);
  assert.equal(output.action, "backend_orchestrated");
  assert.equal(output.stage, "READY_TO_CONFIRM");
});

test("non-reservation outputs are never rewritten", () => {
  const event = {
    type: "conversation.item.create",
    item: { type: "function_call_output", output: JSON.stringify({ action: "continue", data_requirement: "MARKETING_CONSENT" }) },
  };
  assert.equal(isLegacyReservationContinueOutput(event), false);
  assert.equal(rewriteReservationClassifierOutput(event, "COLLECTING"), event);
});
