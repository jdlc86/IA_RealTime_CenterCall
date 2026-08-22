import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const v43 = await readFile(new URL("./call-session-v43-handoff-authorization.ts", import.meta.url), "utf8");

test("v43 consumes provider-neutral caller and semantic-tool events", () => {
  assert.match(v43, /adaptRealtimeProviderEvents/);
  assert.match(v43, /CALLER_TRANSCRIPT_COMPLETED/);
  assert.match(v43, /SEMANTIC_TOOL_SELECTED/);
  assert.match(v43, /provider_event_adapter: true/);
});

test("v43 emits handoff and ignored-input tool results through the command port", () => {
  assert.match(v43, /submitToolResult\(\{/);
  assert.match(v43, /toolName: HUMAN_ASSISTANCE/);
  assert.match(v43, /toolName: INPUT_IGNORED/);
  assert.match(v43, /realtimeCommandPortFor\(session\)\.speak/);
});

test("v43 contains no OpenAI wire parser or raw function-call output transport", () => {
  assert.doesNotMatch(v43, /readRealtimeText/);
  assert.doesNotMatch(v43, /parseEvent/);
  assert.doesNotMatch(v43, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(v43, /conversation\.item\.input_audio_transcription\.completed/);
  assert.doesNotMatch(v43, /conversation\.item\.create/);
  assert.doesNotMatch(v43, /function_call_output/);
  assert.doesNotMatch(v43, /session\.send\?\./);
});
