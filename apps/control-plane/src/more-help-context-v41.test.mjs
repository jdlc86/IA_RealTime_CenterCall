import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessControllerCloseIntent,
  resolveReplyToMoreHelpQuestion,
} from "../.test-dist/core-closing-policy.js";

test("v41 contextual more-help reply treats courtesy alone as no more help", () => {
  for (const phrase of [
    "Gracias",
    "Muchas gracias",
    "Gracias por la información",
    "Gracias por la ayuda",
    "Perfecto, gracias",
    "Muy amable",
  ]) {
    assert.equal(resolveReplyToMoreHelpQuestion(phrase), "CLOSE", phrase);
  }
});

test("v41 contextual courtesy does not become global close evidence", () => {
  for (const phrase of [
    "Gracias",
    "Muchas gracias",
    "Gracias por la información",
    "Perfecto, gracias",
  ]) {
    assert.deepEqual(
      assessControllerCloseIntent(phrase),
      { courtesy: true, closeIntent: "ABSTAIN" },
      phrase,
    );
  }
});

test("v41 contextual substantive request outranks courtesy", () => {
  for (const phrase of [
    "Gracias, dime el horario",
    "Muchas gracias, quiero saber el menú",
    "Gracias, ¿a qué hora cerráis?",
    "Gracias, ¿dónde estáis?",
    "No necesito nada más, pero dime el horario",
    "No, pero dime el horario",
  ]) {
    assert.equal(resolveReplyToMoreHelpQuestion(phrase), "CONTINUE", phrase);
  }
});

test("v41 positive reply remains continuation even when courteous", () => {
  for (const phrase of [
    "Sí",
    "Sí, gracias",
    "Gracias, sí",
    "Gracias, sí, necesito saber otra cosa",
    "Claro, gracias",
  ]) {
    assert.equal(resolveReplyToMoreHelpQuestion(phrase), "CONTINUE", phrase);
  }
});

test("v41 existing explicit negative replies still resolve no more help", () => {
  for (const phrase of [
    "No",
    "No, gracias",
    "Nada más, gracias",
    "No necesito nada más",
    "Gracias, eso es todo",
  ]) {
    assert.equal(resolveReplyToMoreHelpQuestion(phrase), "CLOSE", phrase);
  }
});
