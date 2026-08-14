import assert from "node:assert/strict";
import { test } from "node:test";
import { decideClosingTransition } from "../.test-dist/core-closing-policy.js";

test("active workflow requires one closing confirmation turn", () => {
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CLOSING", false), { action: "ASK_CONFIRMATION", pending: true });
});

test("routing also requires confirmation before semantic close", () => {
  assert.deepEqual(decideClosingTransition("ROUTING", "CLOSING", false), { action: "ASK_CONFIRMATION", pending: true });
});

test("business info also requires confirmation before semantic close", () => {
  assert.deepEqual(decideClosingTransition("BUSINESS_INFO", "CLOSING", false), { action: "ASK_CONFIRMATION", pending: true });
});

test("second consecutive closing intent is allowed after confirmation prompt", () => {
  assert.deepEqual(decideClosingTransition("ROUTING", "CLOSING", true), { action: "ALLOW_CLOSE", pending: false });
});

test("structured explicit close confirmation avoids redundant second question", () => {
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CLOSING", false, true), { action: "ALLOW_CLOSE", pending: false });
});

test("non closing turn clears a pending close and continues", () => {
  assert.deepEqual(decideClosingTransition("CREATE_RESERVATION", "CREATE_RESERVATION", true), { action: "CONTINUE", pending: false });
});
