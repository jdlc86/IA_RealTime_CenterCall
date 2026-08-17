import test from "node:test";
import assert from "node:assert/strict";
import {
  beginSemanticCallerTurn,
  initialSemanticTurnDecisionState,
  selectSemanticTool,
  shouldArmSemanticGateAfterTranscript,
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

test("no transcript gate is armed before a caller turn exists", () => {
  const s = initialSemanticTurnDecisionState();
  assert.equal(shouldArmSemanticGateAfterTranscript(s), false);
});
