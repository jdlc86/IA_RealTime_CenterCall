import test from "node:test";
import assert from "node:assert/strict";
import {
  initialMalformedToolCorrectionState,
  observeCallerTurnStarted,
  decideMalformedToolCorrection,
} from "../.test-dist/malformed-tool-correction-policy.js";
import {
  beginSemanticCallerTurn,
  selectSemanticTool,
} from "../.test-dist/semantic-turn-decision-policy.js";

test("malformed tool does not consume authority and only the same tool may correct it", () => {
  let s = initialMalformedToolCorrectionState();
  let decision = decideMalformedToolCorrection(s, "restaurant_reservation_create", '{"starts_at":"2026-08-22","party_size":');
  assert.equal(decision.action, "PASS_INVALID_WITHOUT_CONSUMING");
  s = decision.next;
  assert.equal(s.pendingMalformedTool, "restaurant_reservation_create");

  decision = decideMalformedToolCorrection(s, "restaurant_reservation_create", '{"starts_at":"2026-08-22","party_size":2}');
  assert.equal(decision.action, "PASS_VALID_CORRECTION_TO_V29");
  assert.equal(decision.next.pendingMalformedTool, null);
});

test("a different valid tool cannot replace a malformed semantic choice in the same caller turn", () => {
  let s = initialMalformedToolCorrectionState();
  s = decideMalformedToolCorrection(s, "restaurant_reservation_create", '{"starts_at":').next;

  const crossTool = decideMalformedToolCorrection(s, "restaurant_human_assistance", '{}');
  assert.equal(crossTool.action, "REJECT_CROSS_TOOL_CORRECTION");
  assert.equal(crossTool.next.pendingMalformedTool, "restaurant_reservation_create");
});

test("a fresh caller turn clears malformed correction affinity", () => {
  let s = initialMalformedToolCorrectionState();
  s = decideMalformedToolCorrection(s, "restaurant_reservation_create", '{"starts_at":').next;
  s = observeCallerTurnStarted(s);

  const nextTurn = decideMalformedToolCorrection(s, "restaurant_human_assistance", '{}');
  assert.equal(nextTurn.action, "PASS_TO_V29");
});

test("same-tool correction still preserves one authoritative semantic decision and blocks double mutation", () => {
  let correction = initialMalformedToolCorrectionState();
  correction = decideMalformedToolCorrection(correction, "restaurant_reservation_create", '{"party_size":').next;
  const corrected = decideMalformedToolCorrection(correction, "restaurant_reservation_create", '{"party_size":2}');
  assert.equal(corrected.action, "PASS_VALID_CORRECTION_TO_V29");

  let semantic = beginSemanticCallerTurn();
  const first = selectSemanticTool(semantic, "restaurant_reservation_create");
  assert.equal(first.allowed, true);
  semantic = first.next;

  const duplicateMutation = selectSemanticTool(semantic, "restaurant_reservation_create");
  assert.equal(duplicateMutation.allowed, false);
  assert.equal(duplicateMutation.duplicateOf, "restaurant_reservation_create");
});
