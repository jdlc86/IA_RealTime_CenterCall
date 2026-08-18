import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v45-barge-in-semantic-authority.ts", import.meta.url), "utf8");

test("v45 uses provider-neutral semantic tool events and tool results", () => {
  assert.match(source, /adaptRealtimeProviderEvents/);
  assert.match(source, /SEMANTIC_TOOL_SELECTED/);
  assert.match(source, /event\.callId/);
  assert.match(source, /submitToolResult/);
  assert.doesNotMatch(source, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(source, /conversation\.item\.create/);
  assert.doesNotMatch(source, /function_call_output/);
  assert.doesNotMatch(source, /event\.call_id/);
});

test("v45 preserves the existing classifier deferral authority", () => {
  assert.match(source, /decideBargeInPublicToolRoute/);
  assert.match(source, /DEFER_TO_CLASSIFIER/);
  assert.match(source, /PUBLIC_TOOL_DEFERRED_TO_BARGE_IN_CLASSIFIER_V45/);
  assert.match(source, /business_action_executed: false/);
});
