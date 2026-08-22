import test from "node:test";
import assert from "node:assert/strict";
import { shouldBlockIgnoredInputForDirectedTurn } from "../.test-dist/directed-turn-authority.js";

test("confirmed caller-directed item cannot be downgraded to background", () => {
  assert.equal(shouldBlockIgnoredInputForDirectedTurn({
    semanticGateArmed: true,
    activeItemId: "item-1",
    directedItemId: "item-1",
  }), true);
});

test("normal or unrelated turns remain eligible for ignored-input classification", () => {
  assert.equal(shouldBlockIgnoredInputForDirectedTurn({
    semanticGateArmed: true,
    activeItemId: "item-2",
    directedItemId: "item-1",
  }), false);
  assert.equal(shouldBlockIgnoredInputForDirectedTurn({
    semanticGateArmed: false,
    activeItemId: "item-1",
    directedItemId: "item-1",
  }), false);
});
