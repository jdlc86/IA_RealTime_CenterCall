import test from "node:test";
import assert from "node:assert/strict";
import {
  BARGE_IN_METADATA_PURPOSE,
  buildBargeInClassifierResponse,
  buildNonInterruptingListeningEvent,
  parseBargeInDecision,
} from "../.test-dist/barge-in-confirmation.js";

test("classifier is out-of-conversation and text-only", () => {
  const event = buildBargeInClassifierResponse("Espera, quiero reservar", "item-1");
  assert.equal(event.type, "response.create");
  assert.equal(event.response.conversation, "none");
  assert.deepEqual(event.response.output_modalities, ["text"]);
  assert.equal(event.response.metadata.purpose, BARGE_IN_METADATA_PURPOSE);
  assert.equal(event.response.metadata.source_item_id, "item-1");
});

test("classifier parser fails closed to IGNORE", () => {
  assert.equal(parseBargeInDecision("INTERRUPT"), "INTERRUPT");
  assert.equal(parseBargeInDecision(" interrupt. "), "INTERRUPT");
  assert.equal(parseBargeInDecision("IGNORE"), "IGNORE");
  assert.equal(parseBargeInDecision("maybe"), "IGNORE");
  assert.equal(parseBargeInDecision(null), "IGNORE");
});

test("listening mode disables automatic interrupt and response creation", () => {
  const event = buildNonInterruptingListeningEvent({ threshold: 0.6 });
  const vad = event.session.audio.input.turn_detection;
  assert.equal(vad.create_response, false);
  assert.equal(vad.interrupt_response, false);
  assert.equal(vad.threshold, 0.6);
});
