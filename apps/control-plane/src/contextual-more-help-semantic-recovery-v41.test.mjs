import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v41-closure-guard.ts", import.meta.url), "utf8");

test("v41 gives unresolved more-help replies a dedicated post-transcript semantic decision", () => {
  assert.match(source, /moreHelpSemanticResolutionPendingV41/);
  assert.match(source, /CONTEXTUAL_MORE_HELP_AWAITING_SEMANTIC_RESOLUTION_V41/);
  assert.match(source, /CONTEXTUAL_MORE_HELP_DECISION_PURPOSE/);
  assert.match(source, /requestTextDecision/);
  assert.match(source, /source_item_id/);
  assert.match(source, /CONTEXTUAL_MORE_HELP_DECISION_REQUESTED_V41/);
  assert.match(source, /CONTEXTUAL_MORE_HELP_DECISION_BOUND_V41/);
  assert.match(source, /TEXT_DECISION_COMPLETED/);
  assert.match(source, /resolution_source:\s*"DEDICATED_MORE_HELP_DECISION_V41"/);
  assert.match(source, /explicit_close_confirmation_required:\s*false/);
});

test("v41 dedicated recovery cannot depend on an earlier unrelated response.done", () => {
  assert.match(source, /contextualMoreHelpDecisionByResponseV41/);
  assert.match(source, /contextualMoreHelpDecisionOwnedResponseIdsV41/);
  assert.match(source, /contextualMoreHelpDecisionFinalizedResponseIdsV41/);
  assert.match(source, /event\.type === "ASSISTANT_RESPONSE_COMPLETED"[\s\S]*contextualMoreHelpDecisionOwnedResponseIdsV41/);
  assert.match(source, /finalizeContextualMoreHelpDecisionV41\(responseId, "CONTINUE"\)/);
  assert.match(source, /DEDICATED_DECISION_CONTINUE_OR_UNCLEAR/);
  assert.doesNotMatch(source, /ASSISTANT_RESPONSE_COMPLETED_WITHOUT_CONTEXTUAL_CLOSE/);
});

test("v41 semantic recovery still allows explicit model end-call or substantive work to supersede it", () => {
  assert.match(source, /readEndCallConfirmedV41\(event\.arguments\)/);
  assert.match(source, /CONTEXTUAL_MORE_HELP_SEMANTIC_CONTEXT_RELEASED_V41/);
  assert.match(source, /event\.name !== END_CALL\s*&&\s*event\.name !== "restaurant_input_ignored"/);
  assert.match(source, /this\.contextualMoreHelpDecisionSourceIdV41 = null/);
});

test("v41 retains the pre-transcript ordering guard for premature end-call", () => {
  assert.match(source, /PREMATURE_END_CALL_SUPERSEDED_BY_MORE_HELP_CONTEXT_V41/);
  assert.match(source, /if \(this\.moreHelpAnswerPendingV41\)/);
  assert.match(source, /acknowledgeContextualReplyPendingV41\(event\.callId\)/);
});

test("v41 contextual closing consumes the consolidated turn and owns unresolved replies", () => {
  assert.match(source, /callerTurnContextRuntimeFor\(this\)\.current\(\) \|\| transcript/);
  assert.match(
    source,
    /resolveMoreHelpAnswerV41\(effectiveTranscript, event\.itemId\)[\s\S]*?moreHelpSemanticResolutionPendingV41\) return;/,
  );
});
