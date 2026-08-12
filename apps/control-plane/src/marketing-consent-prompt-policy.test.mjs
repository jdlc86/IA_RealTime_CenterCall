import assert from "node:assert/strict";
import { test } from "node:test";
import { decideMarketingPrompt } from "../.test-dist/marketing-consent-prompt-policy.js";

test("marketing prompt is eligible only when there is no history", () => {
  assert.deepEqual(decideMarketingPrompt(null), { ask: true, reason: "NO_HISTORY" });
});

for (const status of ["VERIFIED", "DECLINED", "REVOKED"]) {
  test(`marketing prompt is suppressed for existing ${status} decision`, () => {
    assert.deepEqual(decideMarketingPrompt(status), {
      ask: false,
      reason: "EXISTING_DECISION",
      status,
    });
  });
}
