import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./call-session-v41-closure-guard.ts", import.meta.url), "utf8");

test("v41 consumes provider-neutral realtime observations instead of OpenAI inbound wire events", () => {
  assert.match(source, /adaptRealtimeProviderEvents/);
  assert.match(source, /ASSISTANT_TRANSCRIPT_COMPLETED/);
  assert.match(source, /CALLER_TRANSCRIPT_COMPLETED/);
  assert.match(source, /SEMANTIC_TOOL_SELECTED/);
  assert.doesNotMatch(source, /from "\.\/openai-realtime-command-adapter"/);
  assert.doesNotMatch(source, /response\.output_audio_transcript\.done/);
  assert.doesNotMatch(source, /conversation\.item\.input_audio_transcription\.completed/);
  assert.doesNotMatch(source, /response\.function_call_arguments\.done/);
});

test("v41 provider-neutral observation refactor preserves closing authorities", () => {
  assert.match(source, /resolveReplyToMoreHelpQuestion/);
  assert.match(source, /decideCloseConsensus/);
  assert.match(source, /V41_CLOSE_COMMITTED_TO_LIFECYCLE/);
  assert.match(source, /CONTEXTUAL_CLOSE_RESOLVED_V41/);
  assert.match(source, /PREMATURE_END_CALL_SUPERSEDED_BY_MORE_HELP_CONTEXT_V41/);
  assert.doesNotMatch(source, /setTimeout\s*\(/);
  assert.doesNotMatch(source, /sleep\s*\(/);
});
