import test from "node:test";
import assert from "node:assert/strict";
import {
  BARGE_IN_METADATA_PURPOSE,
  buildBargeInClassifierRequest,
  parseBargeInDecision,
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

test("classifier parser fails closed to IGNORE", () => {
  assert.equal(parseBargeInDecision("INTERRUPT"), "INTERRUPT");
  assert.equal(parseBargeInDecision(" interrupt. "), "INTERRUPT");
  assert.equal(parseBargeInDecision("IGNORE"), "IGNORE");
  assert.equal(parseBargeInDecision("maybe"), "IGNORE");
  assert.equal(parseBargeInDecision(null), "IGNORE");
});
