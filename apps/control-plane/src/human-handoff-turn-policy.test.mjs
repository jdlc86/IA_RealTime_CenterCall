import assert from "node:assert/strict";
import { test } from "node:test";
import { beginUserTurn, initialHandoffTurnPolicyState, markResolvedResponseCompleted, recordSelfServiceResult, shouldBlockHumanHandoff } from "../.test-dist/human-handoff-turn-policy.js";

test("resolved business info blocks same-turn handoff", () => {
  let s = beginUserTurn(initialHandoffTurnPolicyState());
  s = recordSelfServiceResult(s, "restaurant_business_info", "FOUND");
  assert.equal(shouldBlockHumanHandoff(s), false);
  s = markResolvedResponseCompleted(s);
  assert.equal(shouldBlockHumanHandoff(s), true);
});

test("new user turn clears handoff block", () => {
  let s = beginUserTurn(initialHandoffTurnPolicyState());
  s = markResolvedResponseCompleted(recordSelfServiceResult(s, "restaurant_business_info", "FOUND"));
  s = beginUserTurn(s);
  assert.equal(shouldBlockHumanHandoff(s), false);
});

test("non-found result does not block handoff", () => {
  let s = beginUserTurn(initialHandoffTurnPolicyState());
  s = markResolvedResponseCompleted(recordSelfServiceResult(s, "restaurant_business_info", "ERROR"));
  assert.equal(shouldBlockHumanHandoff(s), false);
});
