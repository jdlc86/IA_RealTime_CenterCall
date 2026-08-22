import test from "node:test";
import assert from "node:assert/strict";
import { isPresenceAcknowledgementTurn, isPureGreetingTurn } from "../.test-dist/conversational-turn-policy.js";

test("pure greetings are handled without granting backend tool authority", () => {
  for (const transcript of ["buenas", "¡Hola!", "Buenos días", "Hola, Lucía", "muy buenas"]) {
    assert.equal(isPureGreetingTurn(transcript), true, transcript);
  }
});

test("a greeting plus a substantive request remains in the semantic tool flow", () => {
  for (const transcript of [
    "buenas, quiero reservar",
    "hola, ¿tengo alguna reserva?",
    "buenas tardes, dime el horario",
    "hola, quiero cancelar una mesa",
  ]) {
    assert.equal(isPureGreetingTurn(transcript), false, transcript);
  }
});

test("presence acknowledgements cover short contextual answers", () => {
  for (const transcript of ["sí", "Sí, sigo aquí", "aquí estoy", "te escucho", "sí, dime"]) {
    assert.equal(isPresenceAcknowledgementTurn(transcript), true, transcript);
  }
});

test("compound business turns are not swallowed as presence acknowledgements", () => {
  for (const transcript of [
    "sí, quiero reservar",
    "sigo aquí, dime qué reservas tengo",
    "sí, cancela la reserva",
    "aquí estoy con una pregunta sobre el horario",
  ]) {
    assert.equal(isPresenceAcknowledgementTurn(transcript), false, transcript);
  }
});
