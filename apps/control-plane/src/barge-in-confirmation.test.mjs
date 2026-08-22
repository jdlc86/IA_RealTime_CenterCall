import test from "node:test";
import assert from "node:assert/strict";
import {
  BARGE_IN_METADATA_PURPOSE,
  buildBargeInClassifierRequest,
  parseBargeInDecision,
} from "../.test-dist/barge-in-confirmation.js";

test("classifier requires positive certification before destructive ignore", () => {
  const request = buildBargeInClassifierRequest("¿A qué hora cierran?", "item-hours");
  assert.equal(request.purpose, BARGE_IN_METADATA_PURPOSE);
  assert.equal(request.metadata.source_item_id, "item-hours");
  assert.equal(request.maxOutputTokens, 8);
  assert.match(request.inputText, /hora cierran/);
  assert.match(request.instructions, /INTERRUPT/);
  assert.match(request.instructions, /IGNORE_CONFIRMED/);
  assert.match(request.instructions, /duda.*INTERRUPT/i);
  assert.equal(Object.hasOwn(request, "conversation"), false);
  assert.equal(Object.hasOwn(request, "output_modalities"), false);
});

test("usable transcript is preserved unless background is explicitly certified", () => {
  assert.equal(parseBargeInDecision("IGNORE_CONFIRMED"), "IGNORE");
  assert.equal(parseBargeInDecision(" ignore_confirmed. "), "IGNORE");
  assert.equal(parseBargeInDecision("INTERRUPT"), "INTERRUPT");
  assert.equal(parseBargeInDecision("IGNORE"), "INTERRUPT");
  assert.equal(parseBargeInDecision("maybe"), "INTERRUPT");
  assert.equal(parseBargeInDecision(null), "INTERRUPT");
});
