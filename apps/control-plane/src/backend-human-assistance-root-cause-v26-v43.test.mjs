import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("backend HUMAN_ASSISTANCE_REQUIRED is owned by v26 instead of returning to AUTO tools", async () => {
  const v26 = await source("call-session-v26.ts");

  assert.match(v26, /BACKEND_HUMAN_ASSISTANCE_TOOLS/);
  assert.match(v26, /restaurant_reservation_create/);
  assert.match(v26, /restaurant_reservation_modify/);
  assert.match(v26, /payload\.ok !== true \|\| payload\.status !== "HUMAN_ASSISTANCE_REQUIRED"/);
  assert.match(v26, /prepareHumanHandoffOfferFromBackendV26/);
  assert.match(v26, /DIRECT_POST_TOOL_HUMAN_ASSISTANCE_OFFER_GOVERNED_V26/);
  assert.match(v26, /purpose: "backend_human_assistance_offer_v26"/);
  assert.match(v26, /tools: "DISABLED"/);
  assert.match(v26, /transfer_started: false/);
  assert.match(v26, /caller_confirmation_required: true/);

  const start = v26.indexOf("const humanAssistance = backendHumanAssistanceRequirement");
  const end = v26.indexOf("const decision = decideDirectPostToolResponse", start);
  assert.ok(start >= 0 && end > start, "backend handoff boundary must precede default post-tool policy");
  const boundary = v26.slice(start, end);
  assert.doesNotMatch(boundary, /setTimeout|sleep\s*\(/);
});

test("backend handoff offer arms v43 authority and clears stale affirmative transcript", async () => {
  const v43 = await source("call-session-v43-handoff-authorization.ts");

  assert.match(v43, /prepareHumanHandoffOfferFromBackendV26/);
  assert.match(v43, /CALLER_ALREADY_AUTHORIZED/);
  assert.match(v43, /existingAuthority\.source === "EXPLICIT_REQUEST"/);
  assert.match(v43, /handoffAuthorizationV43 = \{ offerPending: true \}/);
  assert.match(v43, /latestCallerTranscriptV43 = null/);
  assert.match(v43, /HUMAN_HANDOFF_OFFER_ARMED_FROM_BACKEND_V43/);
  assert.match(v43, /stale_caller_transcript_cleared: true/);
});

test("explicit caller request remains authoritative and avoids redundant confirmation", async () => {
  const v26 = await source("call-session-v26.ts");
  const v43 = await source("call-session-v43-handoff-authorization.ts");

  assert.match(v26, /disposition === "CALLER_ALREADY_AUTHORIZED"/);
  assert.match(v26, /DIRECT_POST_TOOL_HUMAN_ASSISTANCE_ALREADY_AUTHORIZED_V26/);
  assert.match(v26, /return \{ action: "PASS" \}/);
  assert.match(v43, /authorizeHumanHandoff\(\s*initialHumanHandoffAuthorizationState\(\),\s*this\.latestCallerTranscriptV43/s);
  assert.match(v43, /authorization_source: existingAuthority\.source/);
});
