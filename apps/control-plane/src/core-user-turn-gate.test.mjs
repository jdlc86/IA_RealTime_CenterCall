import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consumeClassifierTurn,
  initialUserTurnGateState,
  markUserTurnStarted,
  shouldDeferPresenceRecovery,
} from "../.test-dist/core-user-turn-gate.js";

test("classifier is rejected before any user turn", () => {
  const result = consumeClassifierTurn(initialUserTurnGateState());
  assert.equal(result.allowed, false);
  assert.equal(result.next.pendingUserTurn, false);
});

test("one user turn authorizes exactly one classifier result", () => {
  const armed = markUserTurnStarted(initialUserTurnGateState());
  const first = consumeClassifierTurn(armed);
  assert.equal(first.allowed, true);
  assert.equal(first.next.pendingUserTurn, false);
  const second = consumeClassifierTurn(first.next);
  assert.equal(second.allowed, false);
});

test("presence recovery is allowed only while genuinely waiting for caller", () => {
  assert.equal(shouldDeferPresenceRecovery({ userAudioActive: false, luciaPlaybackActive: false, toolExecutionActive: false }), false);
  assert.equal(shouldDeferPresenceRecovery({ userAudioActive: true, luciaPlaybackActive: false, toolExecutionActive: false }), true);
  assert.equal(shouldDeferPresenceRecovery({ userAudioActive: false, luciaPlaybackActive: true, toolExecutionActive: false }), true);
  assert.equal(shouldDeferPresenceRecovery({ userAudioActive: false, luciaPlaybackActive: false, toolExecutionActive: true }), true);
});
