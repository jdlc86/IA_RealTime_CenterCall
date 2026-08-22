import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationTurnLifecycle } from "../.test-dist/conversation-turn-lifecycle.js";
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

test("configured handoff cancels silence ownership and enters terminal HANDOFF", () => {
  const lifecycle = new ConversationTurnLifecycle();
  lifecycle.dispatch({ type: "assistant_audio_stopped", kind: "NORMAL" });
  assert.equal(lifecycle.snapshot().state, "WAITING_FOR_CALLER");
  assert.equal(lifecycle.snapshot().silenceTimerArmed, true);

  const effects = lifecycle.dispatch({ type: "handoff_started" });
  assert.equal(lifecycle.snapshot().state, "HANDOFF");
  assert.equal(lifecycle.snapshot().silenceTimerArmed, false);
  assert.deepEqual(effects.map((effect) => effect.type), ["CANCEL_SILENCE_TIMER", "SUSPEND_FOR_HANDOFF"]);
});

test("terminal HANDOFF never resumes conversation before transport closure", () => {
  const lifecycle = new ConversationTurnLifecycle();
  lifecycle.dispatch({ type: "handoff_started" });

  assert.deepEqual(lifecycle.dispatch({ type: "assistant_audio_stopped", kind: "NORMAL" }), []);
  assert.deepEqual(lifecycle.dispatch({ type: "speech_started" }), []);
  assert.equal(lifecycle.snapshot().state, "HANDOFF");

  const effects = lifecycle.dispatch({ type: "transport_closed", reason: "human_handoff_transferred" });
  assert.equal(lifecycle.snapshot().state, "CLOSING");
  assert.deepEqual(effects.map((effect) => effect.type), ["CANCEL_MAX_CALL_TIMER", "RESET_PRESENCE_RESPONSE_STATE"]);
});
