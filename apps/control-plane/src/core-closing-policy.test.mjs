import assert from "node:assert/strict";
import { test } from "node:test";
import { decideClosingTransition } from "../.test-dist/core-closing-policy.js";

test("active workflow requires one closing confirmation turn", () => {
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CLOSING", false), { action: "ASK_CONFIRMATION", pending: true });
});

test("second closing intent is allowed after confirmation prompt", () => {
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CLOSING", true), { action: "ALLOW_CLOSE", pending: false });
});

test("non closing turn clears a pending close and continues", () => {
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CREATE_RESERVATION", true), { action: "CONTINUE", pending: false });
});

test("closing outside an operational workflow is immediate", () => {
  assert.deepEqual(decideClosingTransition("BUSINESS_INFO", "CLOSING", false), { action: "ALLOW_CLOSE", pending: false });
});
