import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v23.ts", import.meta.url), "utf8");

test("v23 direct restaurant controller is provider-neutral at its realtime boundary", () => {
  assert.match(source, /adaptRealtimeProviderEvents/);
  assert.match(source, /SEMANTIC_TOOL_SELECTED/);
  assert.match(source, /submitToolResult/);
  assert.match(source, /createDefaultResponse/);
  assert.doesNotMatch(source, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(source, /conversation\.item\.create/);
  assert.doesNotMatch(source, /function_call_output/);
  assert.doesNotMatch(source, /event\.call_id/);
});

test("v23 business and lifecycle authorities remain unchanged by provider refactor", () => {
  assert.match(source, /DIRECT_RESERVATION_QUERY_COMPLETED_V23/);
  assert.match(source, /DIRECT_RESERVATION_CANCEL_COMPLETED_V23/);
  assert.match(source, /DIRECT_RESERVATION_MODIFIED_V23/);
  assert.match(source, /DIRECT_BUSINESS_INFO_COMPLETED_V23/);
  assert.match(source, /DIRECT_END_CALL_CONFIRMED_V23/);
  assert.match(source, /conversationLifecyclePortFor\(this\)\.confirmEndCall/);
  assert.doesNotMatch(source, /observeEndCallConfirmedV18/);
  assert.doesNotMatch(source, /beginClosing/);
});
