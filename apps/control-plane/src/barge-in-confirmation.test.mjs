import test from "node:test";
import assert from "node:assert/strict";
import {
  BARGE_IN_IGNORE_VALIDATION_PURPOSE,
  BARGE_IN_METADATA_PURPOSE,
  buildBargeInClassifierRequest,
  buildBargeInIgnoreValidationRequest,
  parseBargeInDecision,
  parseBargeInIgnoreValidation,
  resolveBargeInDecisionWithIgnoreValidation,
} from "../.test-dist/barge-in-confirmation.js";

test("classifier policy produces a provider-neutral isolated text decision request", () => {
  const request = buildBargeInClassifierRequest("Espera, quiero reservar", "item-1");
  assert.equal(request.purpose, BARGE_IN_METADATA_PURPOSE);
  assert.equal(request.metadata.source_item_id, "item-1");
  assert.equal(request.maxOutputTokens, 8);
  assert.match(request.inputText, /Espera, quiero reservar/);
  assert.match(request.instructions, /INTERRUPT/);
  assert.equal(Object.hasOwn(request, "conversation"), false);
  assert.equal(Object.hasOwn(request, "output_modalities"), false);
});

test("primary classifier parser remains conservative before ignore consensus", () => {
  assert.equal(parseBargeInDecision("INTERRUPT"), "INTERRUPT");
  assert.equal(parseBargeInDecision(" interrupt. "), "INTERRUPT");
  assert.equal(parseBargeInDecision("IGNORE"), "IGNORE");
  assert.equal(parseBargeInDecision("maybe"), "IGNORE");
  assert.equal(parseBargeInDecision(null), "IGNORE");
});

test("usable IGNORE candidate gets an independent directedness validation request", () => {
  const request = buildBargeInIgnoreValidationRequest("¿A qué hora cierran?", "item-hours");
  assert.equal(request.purpose, BARGE_IN_IGNORE_VALIDATION_PURPOSE);
  assert.equal(request.metadata.source_item_id, "item-hours");
  assert.equal(request.maxOutputTokens, 8);
  assert.match(request.inputText, /hora cierran/);
  assert.match(request.instructions, /DIRECTED/);
  assert.match(request.instructions, /BACKGROUND/);
  assert.match(request.instructions, /duda.*DIRECTED/i);
});

test("ignore validation fails non-destructively to DIRECTED", () => {
  assert.equal(parseBargeInIgnoreValidation("BACKGROUND"), "BACKGROUND");
  assert.equal(parseBargeInIgnoreValidation(" background. "), "BACKGROUND");
  assert.equal(parseBargeInIgnoreValidation("DIRECTED"), "DIRECTED");
  assert.equal(parseBargeInIgnoreValidation("maybe"), "DIRECTED");
  assert.equal(parseBargeInIgnoreValidation(null), "DIRECTED");
});

test("destructive IGNORE requires two-stage consensus", () => {
  assert.equal(resolveBargeInDecisionWithIgnoreValidation("INTERRUPT", "BACKGROUND"), "INTERRUPT");
  assert.equal(resolveBargeInDecisionWithIgnoreValidation("IGNORE", "DIRECTED"), "INTERRUPT");
  assert.equal(resolveBargeInDecisionWithIgnoreValidation("IGNORE", "BACKGROUND"), "IGNORE");
});
