import test from "node:test";
import assert from "node:assert/strict";
import { decideBargeInPublicToolRoute } from "../.test-dist/barge-in-semantic-authority.js";

test("public restaurant tool is deferred while v40 classifies the interruption", () => {
  assert.equal(decideBargeInPublicToolRoute("BARGE_IN_CLASSIFYING"), "DEFER_TO_CLASSIFIER");
});

test("same HOURS tool may enter semantic pipeline after INTERRUPT is confirmed", () => {
  assert.equal(decideBargeInPublicToolRoute("CALLER_TURN_READY"), "ALLOW_SEMANTIC_PIPELINE");
});

test("normal caller turns remain unaffected", () => {
  assert.equal(decideBargeInPublicToolRoute("IDLE"), "ALLOW_SEMANTIC_PIPELINE");
  assert.equal(decideBargeInPublicToolRoute("ASSISTANT_ACTIVE"), "ALLOW_SEMANTIC_PIPELINE");
});
