import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const v42 = await readFile(new URL("./call-session-v42-turn-boundaries.ts", import.meta.url), "utf8");
const runtime = await readFile(new URL("./realtime-provider-runtime.ts", import.meta.url), "utf8");

test("v42 observes self-service results through the provider-neutral runtime", () => {
  assert.match(v42, /adaptRealtimeProviderEvents/);
  assert.match(v42, /installRealtimeToolResultObserver/);
  assert.match(v42, /realtimeCommandPortFor/);
  assert.match(v42, /recordSelfServiceResult/);
  assert.match(runtime, /RealtimeToolResultObserver/);
  assert.match(runtime, /installRealtimeToolResultObserver/);
});

test("v42 does not wrap provider transport or inspect OpenAI wire events", () => {
  assert.doesNotMatch(v42, /session\.send\s*=/);
  assert.doesNotMatch(v42, /sendWrappedV42/);
  assert.doesNotMatch(v42, /conversation\.item\.create/);
  assert.doesNotMatch(v42, /function_call_output/);
  assert.doesNotMatch(v42, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(v42, /conversation\.item\.input_audio_transcription\.completed/);
  assert.doesNotMatch(v42, /response\.done/);
});

test("v42 emits redundant-handoff results through the semantic command port", () => {
  assert.match(v42, /submitToolResult\(\{/);
  assert.match(v42, /toolName: HUMAN_ASSISTANCE/);
  assert.match(v42, /HANDOFF_NOT_NEEDED_CURRENT_TURN_RESOLVED/);
  assert.match(v42, /provider_command_port: true/);
});
