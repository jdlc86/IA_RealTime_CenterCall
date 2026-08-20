import test from "node:test";
import assert from "node:assert/strict";
import {
  beginSemanticCallerTurn,
  initialSemanticTurnDecisionState,
  selectSemanticTool,
  shouldArmSemanticGateAfterTranscript,
  shouldBeginSemanticTurnForTranscript,
  shouldConsumeSemanticToolDecision,
  shouldReopenSemanticTurnAfterProvisionalIgnore,
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

test("usable transcript may supersede only a provisional restaurant_input_ignored decision", () => {
  let ignored = beginSemanticCallerTurn();
  ({ next: ignored } = selectSemanticTool(ignored, "restaurant_input_ignored"));
  assert.equal(shouldReopenSemanticTurnAfterProvisionalIgnore(ignored, "restaurant_input_ignored"), true);

  let business = beginSemanticCallerTurn();
  ({ next: business } = selectSemanticTool(business, "restaurant_business_info"));
  assert.equal(shouldReopenSemanticTurnAfterProvisionalIgnore(business, "restaurant_input_ignored"), false);

  const fresh = beginSemanticCallerTurn();
  assert.equal(shouldReopenSemanticTurnAfterProvisionalIgnore(fresh, "restaurant_input_ignored"), false);
});

test("no transcript gate is armed before a caller turn exists", () => {
  const s = initialSemanticTurnDecisionState();
  assert.equal(shouldBeginSemanticTurnForTranscript(s, false), true);
  assert.equal(shouldArmSemanticGateAfterTranscript(s), false);
});

test("malformed tool arguments do not consume the semantic decision slot", () => {
  assert.equal(shouldConsumeSemanticToolDecision('{"starts_at":"2026-08-22","party_size":'), false);
  assert.equal(shouldConsumeSemanticToolDecision('{"starts_at":"2026-08-22","party_size":2}'), true);
  assert.equal(shouldConsumeSemanticToolDecision(undefined), true);
});

test("malformed attempt can be followed by one valid authoritative tool, but not two", () => {
  let s = beginSemanticCallerTurn();

  if (shouldConsumeSemanticToolDecision('{"starts_at":"2026-08-22","party_size":')) {
    ({ next: s } = selectSemanticTool(s, "restaurant_reservation_create"));
  }
  assert.equal(s.decisionTaken, false);

  if (shouldConsumeSemanticToolDecision('{"starts_at":"2026-08-22","party_size":2}')) {
    const corrected = selectSemanticTool(s, "restaurant_reservation_create");
    assert.equal(corrected.allowed, true);
    s = corrected.next;
  }

  const second = selectSemanticTool(s, "restaurant_reservation_cancel");
  assert.equal(second.allowed, false);
  assert.equal(second.duplicateOf, "restaurant_reservation_create");
});
