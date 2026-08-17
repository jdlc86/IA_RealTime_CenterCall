import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideClosingTransition,
  hasExplicitUserFarewellEvidence,
  isExplicitClosingConfirmation,
  shouldCommitPendingClose,
} from "../.test-dist/core-closing-policy.js";

test("active workflow requires one closing confirmation turn", () => {
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CLOSING", false), { action: "ASK_CONFIRMATION", pending: true });
});

test("routing also requires confirmation before semantic close", () => {
  assert.deepEqual(decideClosingTransition("ROUTING", "CLOSING", false), { action: "ASK_CONFIRMATION", pending: true });
});

test("business info also requires confirmation before semantic close", () => {
  assert.deepEqual(decideClosingTransition("BUSINESS_INFO", "CLOSING", false), { action: "ASK_CONFIRMATION", pending: true });
});

test("second consecutive closing intent is allowed after confirmation prompt", () => {
  assert.deepEqual(decideClosingTransition("ROUTING", "CLOSING", true), { action: "ALLOW_CLOSE", pending: false });
});

test("structured explicit close confirmation avoids redundant second question", () => {
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CLOSING", false, true), { action: "ALLOW_CLOSE", pending: false });
});

test("non closing turn clears a pending close and continues", () => {
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CREATE_RESERVATION", true), { action: "CONTINUE", pending: false });
});

test("direct user farewells are end-call evidence", () => {
  for (const phrase of ["Adiós", "Hasta luego", "Puedes colgar", "Quiero terminar la llamada", "Gracias, adiós", "Eso es todo"]) {
    assert.equal(hasExplicitUserFarewellEvidence(phrase), true, phrase);
  }
});

test("business completion and courtesy are not end-call evidence", () => {
  for (const phrase of ["Sí, confirma la reserva", "No quiero promociones", "Perfecto, gracias", "La primera opción me vale", "¿A qué hora cerráis?"]) {
    assert.equal(hasExplicitUserFarewellEvidence(phrase), false, phrase);
  }
});

test("yes can confirm only a previously pending closing question", () => {
  assert.equal(isExplicitClosingConfirmation("Sí"), true);
  assert.equal(isExplicitClosingConfirmation("Vale"), true);
  assert.equal(isExplicitClosingConfirmation("No, todavía no"), false);
  assert.equal(shouldCommitPendingClose(true, "Sí"), true);
  assert.equal(shouldCommitPendingClose(true, "Vale"), true);
  assert.equal(shouldCommitPendingClose(false, "Sí"), false);
  assert.equal(shouldCommitPendingClose(true, "No, todavía no"), false);
});

test("pending close plus explicit confirmation is independent of model retry ordering", () => {
  assert.equal(shouldCommitPendingClose(true, "Sí, claro"), true);
  assert.equal(shouldCommitPendingClose(true, "Confirmo"), true);
});
