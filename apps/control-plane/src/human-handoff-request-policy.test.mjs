import test from "node:test";
import assert from "node:assert/strict";
import { isExplicitHumanHandoffRequest } from "../.test-dist/human-handoff-request-policy.js";

test("explicit human request is accepted", () => {
  assert.equal(isExplicitHumanHandoffRequest("Pásame con una persona"), true);
  assert.equal(isExplicitHumanHandoffRequest("Quiero hablar con recepción"), true);
  assert.equal(isExplicitHumanHandoffRequest("Ponme con alguien del equipo"), true);
  assert.equal(isExplicitHumanHandoffRequest("¿Me puede transferir con un agente?"), true);
  assert.equal(isExplicitHumanHandoffRequest("¿Podrías pasarme con recepción?"), true);
});

test("polite transfer wording still requires a human target", () => {
  assert.equal(isExplicitHumanHandoffRequest("¿Me puede transferir la llamada mañana?"), false);
  assert.equal(isExplicitHumanHandoffRequest("¿Puedes comunicarme el horario?"), false);
});

test("normal restaurant conversation never authorizes transfer", () => {
  assert.equal(isExplicitHumanHandoffRequest("¿Qué tenéis en el menú?"), false);
  assert.equal(isExplicitHumanHandoffRequest("Quiero hacer una reserva"), false);
  assert.equal(isExplicitHumanHandoffRequest("¿A qué hora cerráis?"), false);
});

test("negated transfer is rejected", () => {
  assert.equal(isExplicitHumanHandoffRequest("No me pases con nadie"), false);
  assert.equal(isExplicitHumanHandoffRequest("No quiero hablar con una persona"), false);
});
