import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8");

for (const file of ["call-session-v24.ts", "call-session-v25.ts"]) {
  test(`${file} uses provider-neutral tool events and tool-result commands`, async () => {
    const source = await read(file);
    assert.match(source, /adaptRealtimeProviderEvents/);
    assert.match(source, /realtimeCommandPortFor/);
    assert.match(source, /SEMANTIC_TOOL_SELECTED/);
    assert.match(source, /submitToolResult/);
    assert.match(source, /createDefaultResponse/);
    assert.doesNotMatch(source, /response\.function_call_arguments\.done/);
    assert.doesNotMatch(source, /conversation\.item\.create/);
    assert.doesNotMatch(source, /function_call_output/);
    assert.doesNotMatch(source, /event\.call_id/);
  });
}
