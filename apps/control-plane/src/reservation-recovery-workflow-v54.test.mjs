import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("reservation-time guard is silent and leaves missing-field speech to the post-tool owner", async () => {
  const v53 = await source("call-session-v53-reservation-time-authority.ts");
  const start = v53.indexOf("private rejectUnprovenTimeV53");
  const end = v53.indexOf("private async handleRealtimeMessage", start);
  assert.ok(start >= 0 && end > start, "V53 rejection boundary must exist");
  const rejection = v53.slice(start, end);

  assert.match(rejection, /submitToolResult/);
  assert.doesNotMatch(rejection, /\.speak\s*\(/, "V53 must not speak as a second response owner");
  assert.match(rejection, /starts_at_time/);
});

test("starts_at_time missing information asks explicitly for the time and never a generic unknown field", async () => {
  const policy = await source("post-booking-conversation-policy.ts");
  assert.match(policy, /starts_at_time/);
  assert.match(policy, /¿A qué hora quieres hacer la reserva\?/);
});

test("capacity-policy failure offers real alternative search before human handoff", async () => {
  const v26 = await source("call-session-v26.ts");
  assert.match(v26, /CAPACITY_POLICY_REQUIRES_HUMAN/);
  assert.match(v26, /SEARCH_ALTERNATIVE_SLOTS/);
  assert.match(v26, /restaurant_reservation_search/);
  assert.match(v26, /tools: "DISABLED"/);

  const humanStart = v26.indexOf("const humanAssistance = backendHumanAssistanceRequirement");
  const policyStart = v26.indexOf("const decision = decideDirectPostToolResponse", humanStart);
  assert.ok(humanStart >= 0 && policyStart > humanStart);
  const boundary = v26.slice(humanStart, policyStart);
  assert.match(boundary, /CAPACITY_POLICY_REQUIRES_HUMAN/);
  assert.match(boundary, /alternativ/i);
  assert.doesNotMatch(boundary, /setTimeout|sleep\s*\(/);
});
