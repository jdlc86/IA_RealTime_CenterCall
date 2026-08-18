import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyControllerCloseSignal,
  decideCloseConsensus,
  decideClosingTransition,
  decideEndCallProposal,
  hasExplicitUserFarewellEvidence,
  isExplicitClosingConfirmation,
  isExplicitClosingRejection,
  shouldCommitPendingClose,
} from "../.test-dist/core-closing-policy.js";

test("courtesy alone is not closing intent", () => {
  for (const phrase of [
    "Gracias",
    "Muchas gracias",
    "Gracias por la información",
    "Gracias por la ayuda",
    "Perfecto, gracias",
  ]) {
    assert.equal(classifyControllerCloseSignal(phrase), "COURTESY", phrase);
  }
});

test("clear farewells are controller CLOSE evidence", () => {
  for (const phrase of [
    "Adiós",
    "Hasta luego",
    "Puedes colgar",
    "Quiero terminar la llamada",
    "Gracias, adiós",
    "Bueno, pues muchas gracias y hasta luego",
    "Perfecto, puedes colgar ya",
    "Eso es todo",
    "Pues ya está, muchas gracias",
  ]) {
    assert.equal(hasExplicitUserFarewellEvidence(phrase), true, phrase);
    assert.equal(classifyControllerCloseSignal(phrase), "CLOSE", phrase);
  }
});

test("explicit continuation is not close", () => {
  for (const phrase of [
    "No quiero terminar la llamada",
    "Todavía no cuelgues",
    "No cuelgues",
    "Continúa",
  ]) {
    assert.equal(classifyControllerCloseSignal(phrase), "CONTINUE", phrase);
  }
});

test("business completion with a new request remains unresolved, not close", () => {
  for (const phrase of [
    "No necesito nada más sobre la reserva pero dime el horario",
    "Eso es todo sobre las reservas, ahora dime el menú",
    "La primera opción me vale",
    "¿A qué hora cerráis?",
  ]) {
    assert.equal(hasExplicitUserFarewellEvidence(phrase), false, phrase);
    assert.equal(classifyControllerCloseSignal(phrase), "UNRESOLVED", phrase);
  }
});

test("Lucia CLOSE plus controller CLOSE reaches consensus", () => {
  assert.deepEqual(decideCloseConsensus(false, "CLOSE", true), {
    action: "CONSENSUS_CLOSE",
    pending: false,
  });
});

test("Lucia CLOSE plus courtesy becomes ambiguity, not veto or close", () => {
  assert.deepEqual(decideCloseConsensus(false, "COURTESY", true), {
    action: "AMBIGUOUS_CONFIRM",
    pending: true,
  });
});

test("Lucia CLOSE plus unresolved controller becomes ambiguity", () => {
  assert.deepEqual(decideCloseConsensus(false, "UNRESOLVED", true), {
    action: "AMBIGUOUS_CONFIRM",
    pending: true,
  });
});

test("Lucia CLOSE plus controller CONTINUE also becomes ambiguity", () => {
  assert.deepEqual(decideCloseConsensus(false, "CONTINUE", true), {
    action: "AMBIGUOUS_CONFIRM",
    pending: true,
  });
});

test("no Lucia close proposal means normal conversation", () => {
  assert.deepEqual(decideCloseConsensus(false, "COURTESY", false), {
    action: "CONTINUE",
    pending: false,
  });
});

test("pending ambiguity suppresses repeated close proposals", () => {
  assert.deepEqual(decideCloseConsensus(true, "CLOSE", true), {
    action: "ACK_PENDING",
    pending: true,
  });
  assert.deepEqual(decideCloseConsensus(true, "UNRESOLVED", true), {
    action: "ACK_PENDING",
    pending: true,
  });
});

test("yes and no resolve an explicit closing question", () => {
  assert.equal(isExplicitClosingConfirmation("Sí"), true);
  assert.equal(isExplicitClosingConfirmation("Vale"), true);
  assert.equal(isExplicitClosingRejection("No"), true);
  assert.equal(isExplicitClosingRejection("No, gracias"), true);
  assert.equal(isExplicitClosingConfirmation("No, todavía no"), false);
  assert.equal(shouldCommitPendingClose(true, "Sí"), true);
  assert.equal(shouldCommitPendingClose(false, "Sí"), false);
});

// Compatibility contracts retained while older layers/tests are retired.
test("legacy end-call adapter maps consensus decisions", () => {
  assert.deepEqual(decideEndCallProposal(false, false, true), { action: "ASK_CONFIRMATION" });
  assert.deepEqual(decideEndCallProposal(true, false, true), { action: "ACK_PENDING" });
  assert.deepEqual(decideEndCallProposal(false, true, true), { action: "ALLOW_CLOSE" });
});

test("legacy workflow closing transition remains compatible", () => {
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CLOSING", false), { action: "ASK_CONFIRMATION", pending: true });
  assert.deepEqual(decideClosingTransition("ROUTING", "CLOSING", true), { action: "ALLOW_CLOSE", pending: false });
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CREATE_RESERVATION", true), { action: "CONTINUE", pending: false });
});
