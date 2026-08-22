import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const v17 = readFileSync(new URL("./call-session-v17.ts", import.meta.url), "utf8");

test("V17 installs public tools through the provider-neutral session policy port", () => {
  assert.match(v17, /realtimeCommandPortFor\(this as any\)\.updateSessionPolicy\(/);
  assert.match(v17, /tools:\s*AGENT_TOOLS/);
  assert.match(v17, /toolChoice:\s*"AUTO"/);
  assert.match(v17, /RealtimeFunctionToolDefinition/);

  assert.doesNotMatch(v17, /session\.update/);
  assert.doesNotMatch(v17, /\(this as any\)\.send\s*\(/);
});

test("V17 consumes semantic tools and emits fallback results through neutral boundaries", () => {
  assert.match(v17, /adaptRealtimeProviderEvents\(data\)/);
  assert.match(v17, /event\.type === "SEMANTIC_TOOL_SELECTED"/);
  assert.match(v17, /realtime\.submitToolResult\(/);
  assert.match(v17, /realtime\.createDefaultResponse\(\)/);
  assert.match(v17, /DIRECT_TOOL_CONTROLLER_MISSING/);

  assert.doesNotMatch(v17, /openai-realtime-(?:event|command)-adapter/);
  assert.doesNotMatch(v17, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(v17, /conversation\.item\.create/);
  assert.doesNotMatch(v17, /function_call_output/);
  assert.doesNotMatch(v17, /\b(?:readRealtimeText|TextDecoder|JSON\.parse)\b/);
  assert.doesNotMatch(v17, /response\.create/);
});

test("V17 gives model-owned natural conversation a non-mutating response path", () => {
  assert.match(v17, /name: "restaurant_conversation"/);
  assert.match(v17, /toolEvent\.name === "restaurant_conversation"/);
  assert.match(v17, /status: "CONVERSATION"/);
  assert.match(v17, /model_owned_interpretation: true/);
  assert.match(v17, /deterministic_phrase_matching: false/);
});
