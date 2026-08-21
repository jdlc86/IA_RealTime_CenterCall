import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./semantic-turn-coordinator.ts", import.meta.url), "utf8");

test("semantic turn coordinator emits provider commands only through the neutral command port", () => {
  assert.match(source, /realtimeCommandPortFor/);
  assert.match(source, /updateSessionPolicy\(\{ toolChoice \}\)/);
  assert.match(source, /port\.submitToolResult/);
  assert.match(source, /toolName: event\.name/);

  assert.doesNotMatch(source, /session\.send/);
  assert.doesNotMatch(source, /s\.send/);
  assert.doesNotMatch(source, /session\.update/);
  assert.doesNotMatch(source, /conversation\.item\.create/);
  assert.doesNotMatch(source, /function_call_output/);
  assert.doesNotMatch(source, /response\.create/);
});

test("semantic gate still maps required and auto choices through neutral policy values", () => {
  assert.match(source, /updateToolChoice\(session, "REQUIRED"\)/);
  assert.match(source, /updateToolChoice\(session, "AUTO"\)/);
  assert.match(source, /toolChoice: "AUTO" \| "REQUIRED"/);
});
