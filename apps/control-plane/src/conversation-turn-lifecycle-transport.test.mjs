import test from "node:test";
import assert from "node:assert/strict";
import { ConversationTurnLifecycle } from "../.test-dist/conversation-turn-lifecycle.js";

function effectTypes(effects) {
  return effects.map((effect) => effect.type);
}

test("transport close from waiting cancels silence and all realtime-dependent state", () => {
  const lifecycle = new ConversationTurnLifecycle();
  lifecycle.dispatch({ type: "assistant_audio_stopped", kind: "NORMAL" });
  const epoch = lifecycle.snapshot().silenceEpoch;
  lifecycle.dispatch({ type: "presence_deadline", epoch });

  assert.deepEqual(
    effectTypes(lifecycle.dispatch({ type: "transport_closed", reason: "sideband_closed" })),
    ["CANCEL_SILENCE_TIMER", "CANCEL_MAX_CALL_TIMER", "RESET_PRESENCE_RESPONSE_STATE"],
  );
  assert.equal(lifecycle.snapshot().state, "CLOSING");
  assert.equal(lifecycle.snapshot().silenceTimerArmed, false);
  assert.equal(lifecycle.snapshot().presenceCheckIssued, false);
  assert.deepEqual(lifecycle.dispatch({ type: "silence_close_deadline", epoch }), []);
  assert.deepEqual(lifecycle.dispatch({ type: "presence_deadline", epoch }), []);
});

test("transport close is terminal even while handoff owns the conversation", () => {
  const lifecycle = new ConversationTurnLifecycle();
  lifecycle.dispatch({ type: "assistant_audio_stopped", kind: "NORMAL" });
  lifecycle.dispatch({ type: "handoff_started" });

  assert.deepEqual(
    effectTypes(lifecycle.dispatch({ type: "transport_closed", reason: "sideband_closed" })),
    ["CANCEL_MAX_CALL_TIMER", "RESET_PRESENCE_RESPONSE_STATE"],
  );
  assert.equal(lifecycle.snapshot().state, "CLOSING");
});

test("transport close still clears runtime deadlines after lifecycle already entered closing", () => {
  const lifecycle = new ConversationTurnLifecycle();
  lifecycle.dispatch({ type: "end_call" });
  lifecycle.dispatch({ type: "assistant_audio_stopped", kind: "TERMINAL" });
  assert.equal(lifecycle.snapshot().state, "CLOSING");

  assert.deepEqual(
    effectTypes(lifecycle.dispatch({ type: "transport_closed", reason: "sideband_closed" })),
    ["CANCEL_MAX_CALL_TIMER", "RESET_PRESENCE_RESPONSE_STATE"],
  );
  assert.equal(lifecycle.snapshot().state, "CLOSING");
});
