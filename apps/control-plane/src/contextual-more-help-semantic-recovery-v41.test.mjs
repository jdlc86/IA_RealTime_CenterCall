import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v41-closure-guard.ts", import.meta.url), "utf8");

test("v41 delegates a reply to a more-help question to the main conversational model", () => {
  assert.match(source, /moreHelpSemanticResolutionPendingV41/);
  assert.match(source, /contextual_authority:\s*"MAIN_CONVERSATION_MODEL"/);
  assert.match(source, /transcript_resolution:\s*"NOT_RULE_CLASSIFIED"/);
  assert.match(source, /phrase_enumeration_used:\s*false/);
  assert.doesNotMatch(source, /resolveReplyToMoreHelpQuestion/);
  assert.doesNotMatch(source, /requestTextDecision/);
  assert.doesNotMatch(source, /CONTEXTUAL_MORE_HELP_DECISION_PURPOSE/);
  assert.doesNotMatch(source, /TEXT_DECISION_COMPLETED/);
});

test("v41 lets the selected semantic tool resolve contextual continuation or close", () => {
  assert.match(source, /readEndCallConfirmedV41\(event\.arguments\)/);
  assert.match(source, /resolveContextualSemanticEndCallV41\(event\.callId, modelConfirmed\)/);
  assert.match(source, /event\.name !== END_CALL\s*&&\s*event\.name !== "restaurant_input_ignored"/);
  assert.match(source, /reason:\s*"SUBSTANTIVE_TOOL_SELECTED"/);
  assert.match(source, /callerTurnContextRuntimeFor\(this\)\.current\(\) \|\| transcript/);
  assert.match(source, /this\.resolveMoreHelpAnswerV41\(\)/);
});

test("v41 retains the pre-transcript ordering guard for premature end-call", () => {
  assert.match(source, /PREMATURE_END_CALL_SUPERSEDED_BY_MORE_HELP_CONTEXT_V41/);
  assert.match(source, /if \(this\.moreHelpAnswerPendingV41\)/);
  assert.match(source, /acknowledgeContextualReplyPendingV41\(event\.callId\)/);
});
