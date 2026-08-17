import test from "node:test";
import assert from "node:assert/strict";
import {
  claimBargeInListening,
  initialBargeInListeningOwnership,
  invalidateBargeInListening,
} from "../.test-dist/barge-in-listening-ownership.js";

test("playback clear invalidates listening so the next response reasserts it", () => {
  let state = initialBargeInListeningOwnership();

  let claim = claimBargeInListening(state, "response-A");
  assert.equal(claim.shouldAssertListening, true);
  state = claim.next;

  state = invalidateBargeInListening(state);

  claim = claimBargeInListening(state, "response-B");
  assert.equal(claim.shouldAssertListening, true);
  state = claim.next;

  const duplicate = claimBargeInListening(state, "response-B");
  assert.equal(duplicate.shouldAssertListening, false);
});
