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

test("v41 emits synthetic tool results through the provider-neutral command boundary", () => {
  assert.match(source, /submitEndCallToolResultV41/);
  assert.match(source, /submitToolResult/);
  assert.match(source, /toolName: END_CALL/);
  assert.doesNotMatch(source, /conversation\.item\.create/);
  assert.doesNotMatch(source, /function_call_output/);
});

test("v41 governs session instructions exclusively through the provider-neutral policy transform", () => {
  assert.match(source, /installRealtimeSessionPolicyTransform/);
  assert.match(source, /instructions: withClosingGuidance\(update\.instructions\)/);
  assert.doesNotMatch(source, /originalSendV41/);
  assert.doesNotMatch(source, /session\.send\s*=/);
  assert.doesNotMatch(source, /message\?\.type === "session\.update"/);
});

test("v41 terminal decisions use lifecycle authority instead of legacy session flags", () => {
  assert.match(source, /conversationLifecyclePortFor\(this\)\.isTerminal\(\)/);
  assert.doesNotMatch(source, /session\.state\s*===\s*"closing"/);
  assert.doesNotMatch(source, /session\.hangupStarted/);
});

test("v41 provider-neutral refactor preserves closing authorities behind neutral owners", () => {
  assert.match(source, /closingSessionRuntimeFor/);
  assert.match(source, /conversationLifecyclePortFor/);
  assert.match(source, /resolveReplyToMoreHelpQuestion/);
  assert.match(source, /decideCloseConsensus/);
  assert.match(source, /V41_CLOSE_COMMITTED_TO_LIFECYCLE/);
  assert.match(source, /CONTEXTUAL_CLOSE_RESOLVED_V41/);
  assert.match(source, /PREMATURE_END_CALL_SUPERSEDED_BY_MORE_HELP_CONTEXT_V41/);
  assert.doesNotMatch(source, /closingConfirmationPendingV41/);
  assert.doesNotMatch(source, /controllerCloseAssessmentV41/);
  assert.doesNotMatch(source, /setTimeout\s*\(/);
  assert.doesNotMatch(source, /sleep\s*\(/);
});
