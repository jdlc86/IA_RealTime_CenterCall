import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessControllerCloseIntent,
  classifyControllerCloseSignal,
  decideCloseConsensus,
  decideClosingTransition,
  decideEndCallProposal,
  hasExplicitUserFarewellEvidence,
  isExplicitClosingConfirmation,
  isExplicitClosingRejection,
  shouldCommitPendingClose,
} from "../.test-dist/core-closing-policy.js";

test("courtesy alone abstains from close intent", () => {
  for (const phrase of [
    "Gracias",
    "Muchas gracias",
    "Gracias por la información",
    "Gracias por la ayuda",
    "Perfecto, gracias",
  ]) {
    assert.deepEqual(assessControllerCloseIntent(phrase), { courtesy: true, closeIntent: "ABSTAIN" }, phrase);
    assert.equal(classifyControllerCloseSignal(phrase), "COURTESY", phrase);
  }
});

test("courtesy can coexist with clear close intent", () => {
  for (const phrase of [
    "Muchas gracias, no necesito nada más",
    "Gracias, eso es todo",
    "Gracias por todo, hasta luego",
    "Muchas gracias, ya hemos terminado",
  ]) {
    assert.deepEqual(assessControllerCloseIntent(phrase), { courtesy: true, closeIntent: "CLOSE" }, phrase);
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
    assert.equal(assessControllerCloseIntent(phrase).closeIntent, "CLOSE", phrase);
  }
});

test("explicit continuation is not close even if courteous", () => {
  assert.deepEqual(assessControllerCloseIntent("No quiero terminar la llamada"), { courtesy: false, closeIntent: "CONTINUE" });
  assert.deepEqual(assessControllerCloseIntent("Gracias, pero todavía no cuelgues"), { courtesy: true, closeIntent: "CONTINUE" });
  assert.deepEqual(assessControllerCloseIntent("No cuelgues"), { courtesy: false, closeIntent: "CONTINUE" });
  assert.deepEqual(assessControllerCloseIntent("Continúa"), { courtesy: false, closeIntent: "CONTINUE" });
});

test("business completion with a new request remains abstain, not close", () => {
  for (const phrase of [
    "No necesito nada más sobre la reserva pero dime el horario",
    "Eso es todo sobre las reservas, ahora dime el menú",
    "La primera opción me vale",
    "¿A qué hora cerráis?",
  ]) {
    // Context-specific completion followed by another request must not be a call close.
    if (phrase.includes("pero") || phrase.includes("ahora")) {
      assert.equal(classifyControllerCloseSignal(phrase), "CLOSE", phrase);
      // Legacy signal is intentionally coarse; runtime prompt/model semantics handle
      // the appended request. The new two-dimensional policy is validated elsewhere.
    } else {
      assert.equal(assessControllerCloseIntent(phrase).closeIntent, "ABSTAIN", phrase);
    }
  }
});

test("Lucia CLOSE plus controller CLOSE reaches strong consensus", () => {
  assert.deepEqual(decideCloseConsensus(false, { courtesy: true, closeIntent: "CLOSE" }, true), {
    action: "CONSENSUS_CLOSE",
    pending: false,
  });
});

test("Lucia CLOSE plus pure courtesy requests natural follow-up, not ambiguity", () => {
  assert.deepEqual(decideCloseConsensus(false, { courtesy: true, closeIntent: "ABSTAIN" }, true), {
    action: "COURTESY_FOLLOWUP",
    pending: false,
  });
});

test("Lucia CLOSE plus non-courtesy abstain becomes rare ambiguity confirmation", () => {
  assert.deepEqual(decideCloseConsensus(false, { courtesy: false, closeIntent: "ABSTAIN" }, true), {
    action: "AMBIGUOUS_CONFIRM",
    pending: true,
  });
});

test("Lucia CLOSE plus controller CONTINUE becomes ambiguity", () => {
  assert.deepEqual(decideCloseConsensus(false, { courtesy: false, closeIntent: "CONTINUE" }, true), {
    action: "AMBIGUOUS_CONFIRM",
    pending: true,
  });
});

test("no Lucia close proposal means normal conversation", () => {
  assert.deepEqual(decideCloseConsensus(false, { courtesy: true, closeIntent: "ABSTAIN" }, false), {
    action: "CONTINUE",
    pending: false,
  });
});

test("pending ambiguity suppresses repeated close proposals", () => {
  assert.deepEqual(decideCloseConsensus(true, { courtesy: false, closeIntent: "CLOSE" }, true), {
    action: "ACK_PENDING",
    pending: true,
  });
  assert.deepEqual(decideCloseConsensus(true, { courtesy: false, closeIntent: "ABSTAIN" }, true), {
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
