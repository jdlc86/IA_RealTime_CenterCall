import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v19.ts", import.meta.url), "utf8");

test("v19 direct reservation controller is provider-neutral at its realtime boundary", () => {
  assert.match(source, /adaptRealtimeProviderEvents/);
  assert.match(source, /SEMANTIC_TOOL_SELECTED/);
  assert.match(source, /submitToolResult/);
  assert.match(source, /createDefaultResponse/);
  assert.match(source, /toolName: CREATE_RESERVATION/);
  assert.doesNotMatch(source, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(source, /conversation\.item\.create/);
  assert.doesNotMatch(source, /function_call_output/);
  assert.doesNotMatch(source, /event\.call_id/);
});
