import assert from "node:assert/strict";
import { test } from "node:test";
import { decideMarketingPrompt, MARKETING_OFFER_COOLDOWN_DAYS } from "../.test-dist/marketing-consent-prompt-policy.js";

const now = Date.parse("2026-08-12T20:00:00Z");

test("marketing prompt is eligible when there is no decision or prior offer", () => {
  assert.deepEqual(decideMarketingPrompt(null, null, now), { ask: true, reason: "NO_HISTORY" });
});

for (const status of ["VERIFIED", "DECLINED", "REVOKED"]) {
  test(`marketing prompt is permanently suppressed for existing ${status} decision`, () => {
    assert.deepEqual(decideMarketingPrompt(status, "2025-01-01T00:00:00Z", now), {
      ask: false,
      reason: "EXISTING_DECISION",
      status,
    });
  });
}

test("unanswered recent offer suppresses another automatic proposal", () => {
  const lastOfferedAt = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(decideMarketingPrompt(null, lastOfferedAt, now), {
    ask: false,
    reason: "OFFER_COOLDOWN",
    lastOfferedAt,
  });
});

test("unanswered offer becomes eligible after the conservative cooldown", () => {
  const lastOfferedAt = new Date(now - (MARKETING_OFFER_COOLDOWN_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(decideMarketingPrompt(null, lastOfferedAt, now), {
    ask: true,
    reason: "COOLDOWN_EXPIRED",
  });
});

test("invalid persisted offer timestamp fails closed", () => {
  assert.throws(() => decideMarketingPrompt(null, "not-a-date", now), /Invalid marketing offer timestamp/);
});
