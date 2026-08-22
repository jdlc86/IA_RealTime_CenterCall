import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./call-session-v29.ts", import.meta.url), "utf8");

test("v29 routes semantic outputs and session policy through provider-neutral runtime", () => {
  assert.match(source, /installRealtimeToolResultObserver/);
  assert.match(source, /updateSessionPolicy\(/);
  assert.match(source, /toolChoice:\s*"AUTO"/);
  assert.match(source, /submitToolResult\(/);
  assert.match(source, /toolName:\s*INPUT_IGNORED/);

  assert.doesNotMatch(source, /originalSendV29/);
  assert.doesNotMatch(source, /conversation\.item\.create/);
  assert.doesNotMatch(source, /function_call_output/);
  assert.doesNotMatch(source, /session\.update/);
  assert.doesNotMatch(source, /\(this as any\)\.send/);
});

test("v29 outbound observability observes neutral tool results rather than provider wire", () => {
  assert.match(source, /installRealtimeToolResultObserver\(this as any/);
  assert.match(source, /request\.callId/);
  assert.match(source, /request\.toolName/);
  assert.match(source, /request\.output/);
  assert.match(source, /DEBUG_TOOL_OUTPUT_V29/);
});
