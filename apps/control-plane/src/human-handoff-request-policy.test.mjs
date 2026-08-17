import test from "node:test";
import assert from "node:assert/strict";
import { isExplicitHumanHandoffRequest } from "../.test-dist/human-handoff-request-policy.js";

test("explicit transfer requests are accepted", () => {
  assert.equal(isExplicitHumanHandoffRequest("Pásame con una persona, por favor"), true);
  assert.equal(isExplicitHumanHandoffRequest("Quiero hablar con recepción"), true);
  assert.equal(isExplicitHumanHandoffRequest("¿Puedes transferirme con alguien del equipo?"), true);
  assert.equal(isExplicitHumanHandoffRequest("Quisiera hablar con el encargado"), true);
});

test("restaurant conversation never authorizes handoff by itself", () => {
  assert.equal(isExplicitHumanHandoffRequest("¿Qué tenéis en el menú?"), false);
  assert.equal(isExplicitHumanHandoffRequest("Quiero hacer una reserva"), false);
  assert.equal(isExplicitHumanHandoffRequest("¿A qué hora cerráis?"), false);
});

test("negated human transfer requests fail closed", () => {
  assert.equal(isExplicitHumanHandoffRequest("No quiero que me pases con nadie"), false);
  assert.equal(isExplicitHumanHandoffRequest("Prefiero seguir contigo, sin transferirme"), false);
});
