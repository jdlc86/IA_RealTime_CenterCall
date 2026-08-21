import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const v15 = readFileSync(new URL("./call-session-v15.ts", import.meta.url), "utf8");

test("V15 consumes provider-neutral realtime events and commands", () => {
  assert.match(v15, /adaptRealtimeProviderEvents/);
  assert.match(v15, /SEMANTIC_TOOL_SELECTED/);
  assert.match(v15, /ASSISTANT_RESPONSE_COMPLETED/);
  assert.match(v15, /realtimeCommandPortFor/);
  assert.match(v15, /\.submitToolResult\(\{/);

  assert.doesNotMatch(v15, /\bRealtimeEvent\b/);
  assert.doesNotMatch(v15, /\breadRealtimeText\b/);
  assert.doesNotMatch(v15, /\bTextDecoder\b/);
  assert.doesNotMatch(v15, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(v15, /response\.done/);
  assert.doesNotMatch(v15, /conversation\.item\.create/);
  assert.doesNotMatch(v15, /function_call_output/);
});
