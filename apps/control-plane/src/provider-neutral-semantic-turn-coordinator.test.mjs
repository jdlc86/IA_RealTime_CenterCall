import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./semantic-turn-coordinator.ts", import.meta.url), "utf8");

test("semantic turn coordinator emits provider commands only through neutral capability boundaries", () => {
  assert.match(source, /semanticToolGatePortFor/);
  assert.match(source, /\.arm\(\)/);
  assert.match(source, /\.release\(\)/);
  assert.match(source, /realtimeCommandPortFor/);
  assert.match(source, /port\.submitToolResult/);
  assert.match(source, /toolName: event\.name/);

  assert.doesNotMatch(source, /updateSessionPolicy\(\{\s*toolChoice/);
  assert.doesNotMatch(source, /session\.send/);
  assert.doesNotMatch(source, /s\.send/);
  assert.doesNotMatch(source, /session\.update/);
  assert.doesNotMatch(source, /conversation\.item\.create/);
  assert.doesNotMatch(source, /function_call_output/);
  assert.doesNotMatch(source, /response\.create/);
});

test("semantic gate asks for semantic enforcement instead of naming provider tool-choice wire", () => {
  assert.match(source, /semanticToolGatePortFor\(session as any\)\.arm\(\)/);
  assert.match(source, /semanticToolGatePortFor\(session as any\)\.release\(\)/);
  assert.match(source, /provider_capability_boundary: "semantic_tool_gate_port"/);
  assert.doesNotMatch(source, /"REQUIRED"/);
  assert.doesNotMatch(source, /"AUTO"/);
});
