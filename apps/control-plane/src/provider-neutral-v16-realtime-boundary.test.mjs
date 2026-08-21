import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const v16 = readFileSync(new URL("./call-session-v16.ts", import.meta.url), "utf8");

test("V16 consumes semantic realtime events through the provider-neutral boundary", () => {
  assert.match(v16, /adaptRealtimeProviderEvents/);
  assert.match(v16, /for \(const event of adaptRealtimeProviderEvents\(data\)\)/);
  assert.match(v16, /event\.type === "SEMANTIC_TOOL_SELECTED"/);
  assert.match(v16, /event\.name === CONVERSATION_INTENT/);
  assert.match(v16, /this\.captureStructuredTurnV16\(event\.arguments\)/);
  assert.match(v16, /await BasePrototype\.handleRealtimeMessage\.call\(this, data\)/);

  assert.doesNotMatch(v16, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(v16, /readRealtimeText/);
  assert.doesNotMatch(v16, /new TextDecoder\(\)/);
});
