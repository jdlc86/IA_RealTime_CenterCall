import test from "node:test";
import assert from "node:assert/strict";
import { isPureGreetingTurn } from "../.test-dist/conversational-turn-policy.js";

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
