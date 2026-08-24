import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function source(name) {
  return (await readFile(new URL(`./${name}`, import.meta.url), "utf8")).replace(/\r\n?/g, "\n");
}

test("v43 handoff confirmation is emitted once with tools disabled", async () => {
  const v43 = await source("call-session-v43-handoff-authorization.ts");

  assert.match(v43, /realtimeCommandPortFor/);
  assert.match(v43, /human_handoff_confirmation_v43/);
  assert.match(v43, /tools: "DISABLED"/);
  assert.match(v43, /single_confirmation_prompt: true/);
  assert.match(v43, /confirmation_response_tools_disabled: true/);

  const start = v43.indexOf("private async rejectUnauthorizedHandoffV43");
  const end = v43.indexOf("private consumeRejectedOfferMisclassifiedAsIgnoredV43", start);
  assert.ok(start >= 0 && end > start, "v43 unauthorized-handoff boundary must be present");
  const boundary = v43.slice(start, end);

  assert.doesNotMatch(boundary, /send\?\.\(\{ type: "response\.create" \}\)/);
  assert.match(boundary, /optionalIsolatedTextGenerationPortFor\(this\)/);
  assert.match(boundary, /await isolatedGeneration\.generate/);
  assert.match(boundary, /realtimeCommandPortFor\(session\)\.speak/);
  assert.match(boundary, /tools: "DISABLED"/);
  assert.equal((boundary.match(/purpose: "human_handoff_confirmation_v43"/g) ?? []).length, 1);
});

test("v43 suppresses duplicate handoff explanation while confirmation is pending", async () => {
  const v43 = await source("call-session-v43-handoff-authorization.ts");

  assert.match(v43, /offerWasAlreadyPending/);
  assert.match(v43, /HUMAN_HANDOFF_CONFIRMATION_PENDING/);
  assert.match(v43, /duplicate_offer_suppressed: true/);
  assert.match(v43, /human_handoff_confirmation_clarification_v43/);
  assert.match(v43, /No repitas la explicación ni vuelvas a ofrecer la transferencia/);
});

test("v43 clears a stale pending offer only when another semantic business tool wins", async () => {
  const v43 = await source("call-session-v43-handoff-authorization.ts");

  assert.match(v43, /const NATURAL_CONVERSATION = "restaurant_conversation"/);
  assert.match(v43, /clearHumanHandoffOfferForCompetingAction/);
  assert.match(v43, /event\.name !== HUMAN_ASSISTANCE/);
  assert.match(v43, /event\.name !== INPUT_IGNORED/);
  assert.match(v43, /event\.name !== NATURAL_CONVERSATION/);
  assert.match(v43, /HUMAN_HANDOFF_PENDING_OFFER_CLEARED_BY_COMPETING_ACTION_V43/);
});

test("v43 preserves a pending handoff offer across model-owned conversation so a later yes can authorize transfer", async () => {
  const v43 = await source("call-session-v43-handoff-authorization.ts");

  const competingStart = v43.indexOf("if (\n        event.name !== HUMAN_ASSISTANCE");
  const competingEnd = v43.indexOf("if (event.name === HUMAN_ASSISTANCE)", competingStart);
  assert.ok(competingStart >= 0 && competingEnd > competingStart, "handoff competing-action boundary must be present");
  const competingBoundary = v43.slice(competingStart, competingEnd);

  assert.match(competingBoundary, /event\.name !== NATURAL_CONVERSATION/);
  assert.match(v43, /authorizeHumanHandoff\(this\.handoffAuthorizationV43, this\.latestCallerTranscriptV43\)/);
  assert.match(v43, /HUMAN_HANDOFF_AUTHORIZED_BY_CALLER_V43/);
});
