import test from "node:test";
import assert from "node:assert/strict";
import {
  armClassifierTurn,
  consumeClassifierTurn,
  initialClassifierTurnGateState,
} from "../.test-dist/classifier-turn-gate.js";

test("classifier call is rejected until caller speech arms one result", () => {
  const initial = initialClassifierTurnGateState();
  assert.equal(consumeClassifierTurn(initial).allowed, false);
  const armed = armClassifierTurn(initial);
  const consumed = consumeClassifierTurn(armed);
  assert.equal(consumed.allowed, true);
  assert.equal(consumeClassifierTurn(consumed.next).allowed, false);
});

test("repeated speech_started does not mint multiple classifier authorizations", () => {
  let state = initialClassifierTurnGateState();
  state = armClassifierTurn(state);
  state = armClassifierTurn(state);
  const first = consumeClassifierTurn(state);
  assert.equal(first.allowed, true);
  assert.equal(consumeClassifierTurn(first.next).allowed, false);
});
