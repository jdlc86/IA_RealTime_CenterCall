import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v26.ts", import.meta.url), "utf8");

test("v26 post-tool policy runs on the provider-neutral semantic boundary", () => {
  assert.match(source, /installRealtimeToolResultPolicy/);
  assert.match(source, /decideDirectPostToolResponse/);
  assert.match(source, /REPLACE_DEFAULT_RESPONSE/);
  assert.match(source, /DIRECT_POST_TOOL_RESPONSE_GOVERNED_V26/);
  assert.match(source, /DIRECT_POST_TOOL_RESPONSE_DEFERRED_TO_MARKETING_V26/);
  assert.doesNotMatch(source, /readFunctionOutputV26/);
  assert.doesNotMatch(source, /isBareResponseCreateV26/);
  assert.doesNotMatch(source, /conversation\.item\.create/);
  assert.doesNotMatch(source, /function_call_output/);
  assert.doesNotMatch(source, /response\.create/);
});

test("v26 keeps session bootstrap deliberately separate for the next gate", () => {
  assert.match(source, /type: "session\.update"/);
  assert.match(source, /DIRECT_AGENT_RUNTIME_V26_ENABLED/);
  assert.match(source, /tool_choice: "auto"/);
});
