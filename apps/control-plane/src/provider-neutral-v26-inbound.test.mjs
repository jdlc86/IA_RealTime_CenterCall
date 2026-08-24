import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v26.ts", import.meta.url), "utf8");

test("v26 consumes provider-neutral tool-selection events on its inbound boundary", () => {
  assert.match(source, /adaptRealtimeProviderEvents/);
  assert.match(source, /event\.type === "SEMANTIC_TOOL_SELECTED"/);
  assert.match(source, /event\.callId/);
  assert.doesNotMatch(source, /from "\.\/openai-realtime-command-adapter"/);
  assert.doesNotMatch(source, /response\.function_call_arguments\.done/);
});

test("v26 has no direct OpenAI wire dependency after post-tool and session gates", () => {
  assert.match(source, /installRealtimeToolResultPolicy/);
  assert.match(source, /applyRealtimeSessionBootstrapPolicy/);
  assert.match(source, /REPLACE_DEFAULT_RESPONSE/);
  assert.match(source, /DIRECT_POST_TOOL_RESPONSE_GOVERNED_V26/);
  assert.match(source, /LEGACY_CORE_INTENT_EVENT_BLOCKED_V26/);
  assert.doesNotMatch(source, /session\.update/);
  assert.doesNotMatch(source, /conversation\.item\.create/);
  assert.doesNotMatch(source, /function_call_output/);
  assert.doesNotMatch(source, /response\.create/);
});
