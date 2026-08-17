import test from "node:test";
import assert from "node:assert/strict";
import {
  beginSemanticCallerTurn,
  initialSemanticTurnDecisionState,
  selectSemanticTool,
  shouldArmSemanticGateAfterTranscript,
  shouldBeginSemanticTurnForTranscript,
} from "../.test-dist/semantic-turn-decision-policy.js";

test("first public tool before transcript becomes authoritative for the caller turn", () => {
  let s = beginSemanticCallerTurn();
  const first = selectSemanticTool(s, "restaurant_business_info");
  assert.equal(first.allowed, true);
  s = first.next;
  assert.equal(shouldArmSemanticGateAfterTranscript(s), false);
  assert.equal(s.selectedTool, "restaurant_business_info");
});

test("second public tool in the same caller turn is rejected", () => {
  let s = beginSemanticCallerTurn();
  ({ next: s } = selectSemanticTool(s, "restaurant_business_info"));
  const duplicate = selectSemanticTool(s, "restaurant_input_ignored");
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.duplicateOf, "restaurant_business_info");
  assert.equal(duplicate.next.selectedTool, "restaurant_business_info");
});

test("a new speech turn resets semantic authority", () => {
  let s = beginSemanticCallerTurn();
  ({ next: s } = selectSemanticTool(s, "restaurant_business_info"));
  s = beginSemanticCallerTurn();
  const nextTurn = selectSemanticTool(s, "restaurant_input_ignored");
  assert.equal(nextTurn.allowed, true);
  assert.equal(nextTurn.duplicateOf, null);
});

test("confirmed higher-layer barge-in starts a fresh semantic turn even when the previous turn remains open", () => {
  let previous = beginSemanticCallerTurn();
  ({ next: previous } = selectSemanticTool(previous, "restaurant_business_info"));
  assert.equal(previous.turnOpen, true);
  assert.equal(previous.decisionTaken, true);
  assert.equal(shouldBeginSemanticTurnForTranscript(previous, true), true);

  const promoted = beginSemanticCallerTurn();
  const hours = selectSemanticTool(promoted, "restaurant_business_info");
  assert.equal(hours.allowed, true);
  assert.equal(hours.duplicateOf, null);
});

test("ordinary transcript cannot reset an already-decided semantic turn", () => {
  let s = beginSemanticCallerTurn();
  ({ next: s } = selectSemanticTool(s, "restaurant_business_info"));
  assert.equal(shouldBeginSemanticTurnForTranscript(s, false), false);
  const duplicate = selectSemanticTool(s, "restaurant_business_info");
  assert.equal(duplicate.allowed, false);
});

test("no transcript gate is armed before a caller turn exists", () => {
  const s = initialSemanticTurnDecisionState();
  assert.equal(shouldBeginSemanticTurnForTranscript(s, false), true);
  assert.equal(shouldArmSemanticGateAfterTranscript(s), false);
});
