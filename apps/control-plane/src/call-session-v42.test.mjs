import test from "node:test";
import assert from "node:assert/strict";
import { shouldQuiesceConversationLifecycleV42 } from "../.test-dist/call-session-v42-policy.js";

test("v42 quiesces when lower runtime enters closing", () => {
  assert.equal(shouldQuiesceConversationLifecycleV42("closing", false), true);
});

test("v42 quiesces when transport hangup has started", () => {
  assert.equal(shouldQuiesceConversationLifecycleV42("active", true), true);
});

test("v42 leaves active calls untouched", () => {
  assert.equal(shouldQuiesceConversationLifecycleV42("active", false), false);
  assert.equal(shouldQuiesceConversationLifecycleV42(undefined, false), false);
});
