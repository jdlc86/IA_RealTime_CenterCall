import test from "node:test";
import assert from "node:assert/strict";
import {
  initialResponseOwnerSnapshot,
  reduceResponseOwner,
} from "../.test-dist/realtime-response-owner.js";
import { applyBargeInSemanticDecision } from "../.test-dist/response-owner-barge-in-decision.js";

function classifyingSnapshot({ cleared = false } = {}) {
  let s = initialResponseOwnerSnapshot();
  ({ snapshot: s } = reduceResponseOwner(s, { type: "assistant_response_started", responseId: "old" }));
  if (cleared) ({ snapshot: s } = reduceResponseOwner(s, { type: "assistant_playback_cleared" }));
  ({ snapshot: s } = reduceResponseOwner(s, { type: "caller_speech_started" }));
  return s;
}

test("raw speech without semantic decision cannot authorize effects", () => {
  const s = classifyingSnapshot();
  assert.equal(s.state, "BARGE_IN_CLASSIFYING");
  assert.equal(s.activeResponseId, "old");
});

test("INTERRUPT authorizes cancel clear and caller response immediately", () => {
  const r = applyBargeInSemanticDecision(classifyingSnapshot(), "INTERRUPT");
  assert.equal(r.accepted, true);
  assert.equal(r.snapshot.state, "CALLER_TURN_READY");
  assert.deepEqual(r.effects, [
    { type: "cancel_response", responseId: "old" },
    { type: "clear_playback" },
    { type: "create_caller_response" },
  ]);
});

test("INTERRUPT after SIP playback clear never waits for response.done", () => {
  const r = applyBargeInSemanticDecision(classifyingSnapshot({ cleared: true }), "INTERRUPT");
  assert.equal(r.accepted, true);
  assert.deepEqual(r.effects, [
    { type: "cancel_response", responseId: "old" },
    { type: "create_caller_response" },
  ]);
});

test("IGNORE never cancels or creates caller response", () => {
  const r = applyBargeInSemanticDecision(classifyingSnapshot(), "IGNORE");
  assert.equal(r.accepted, true);
  assert.equal(r.snapshot.state, "ASSISTANT_ACTIVE");
  assert.deepEqual(r.effects, []);
});

test("decision outside classifying state is rejected fail-closed", () => {
  const s = initialResponseOwnerSnapshot();
  const r = applyBargeInSemanticDecision(s, "INTERRUPT");
  assert.equal(r.accepted, false);
  assert.equal(r.snapshot, s);
  assert.deepEqual(r.effects, []);
});
