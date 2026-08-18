import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v41-closure-guard.ts", import.meta.url), "utf8");

test("v41 keeps unresolved more-help context for semantic resolution of the same turn", () => {
  assert.match(source, /moreHelpSemanticResolutionPendingV41/);
  assert.match(source, /CONTEXTUAL_MORE_HELP_AWAITING_SEMANTIC_RESOLUTION_V41/);
  assert.match(source, /context_preserved:\s*true/);
  assert.match(source, /resolution_source:\s*"LUCIA_CONFIRMED_END_CALL_AFTER_UNRESOLVED_CONTEXTUAL_TRANSCRIPT"/);
  assert.match(source, /explicit_close_confirmation_required:\s*false/);
});

test("v41 semantic recovery requires confirmed end-call and cannot leak into later turns", () => {
  assert.match(source, /readEndCallConfirmedV41\(event\.arguments\)/);
  assert.match(source, /if \(modelConfirmed !== true\)/);
  assert.match(source, /CONTEXTUAL_MORE_HELP_SEMANTIC_CONTEXT_RELEASED_V41/);
  assert.match(source, /event\.type === "ASSISTANT_RESPONSE_COMPLETED"/);
  assert.match(source, /event\.name !== END_CALL\s*&&\s*event\.name !== "restaurant_input_ignored"/);
});

test("v41 retains the pre-transcript ordering guard for premature end-call", () => {
  assert.match(source, /PREMATURE_END_CALL_SUPERSEDED_BY_MORE_HELP_CONTEXT_V41/);
  assert.match(source, /if \(this\.moreHelpAnswerPendingV41\)/);
  assert.match(source, /acknowledgeContextualReplyPendingV41\(event\.callId\)/);
});
