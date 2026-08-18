import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = async (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8");

test("v41 keeps more-help reply authoritative over premature end-call tool calls", async () => {
  const v41 = await source("call-session-v41-closure-guard.ts");

  assert.match(v41, /if \(this\.moreHelpAnswerPendingV41\) \{\s*this\.acknowledgeContextualReplyPendingV41\(event\.callId\);\s*return;\s*\}/s);
  assert.doesNotMatch(v41, /event\.call_id/);
  assert.match(v41, /PREMATURE_END_CALL_SUPERSEDED_BY_MORE_HELP_CONTEXT_V41/);
  assert.match(v41, /arbitration_started: false/);
  assert.match(v41, /extra_audio_emitted: false/);
  assert.match(v41, /artificial_wait_ms: 0/);
  assert.match(v41, /CONTEXTUAL_CLOSE_RESOLVED_V41/);
  assert.match(v41, /explicit_close_confirmation_required: false/);
});

test("v41 treats repeated more-help observations as idempotent", async () => {
  const v41 = await source("call-session-v41-closure-guard.ts");

  assert.match(v41, /private markMoreHelpQuestionV41\([\s\S]*?if \(this\.moreHelpAnswerPendingV41\) \{[\s\S]*?MORE_HELP_QUESTION_DUPLICATE_OBSERVED_V41[\s\S]*?state_reopened: false[\s\S]*?return;[\s\S]*?this\.moreHelpAnswerPendingV41 = true;/);
  assert.match(v41, /contextual_authority_unchanged: true/);
});
