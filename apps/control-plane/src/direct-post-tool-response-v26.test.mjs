import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("v26 owns one common structured direct post-tool response boundary", async () => {
  const v26 = await source("call-session-v26.ts");

  assert.match(v26, /decideDirectPostToolResponse/);
  assert.match(v26, /installPostToolResponseBoundaryV26/);
  assert.match(v26, /conversation\.item\.create/);
  assert.match(v26, /function_call_output/);
  assert.match(v26, /isBareResponseCreateV26/);
  assert.match(v26, /DIRECT_POST_TOOL_RESPONSE_GOVERNED_V26/);
  assert.match(v26, /realtimeCommandPortFor\(session\)\.speak/);
  assert.match(v26, /tools: "DISABLED"/);
  assert.match(v26, /exact_continuation_question: true/);
  assert.match(v26, /post_tool_response_policy: "structured_terminal_continuation"/);
});

test("v26 preserves marketing subflow and adds no timing heuristic", async () => {
  const v26 = await source("call-session-v26.ts");

  assert.match(v26, /DIRECT_POST_TOOL_RESPONSE_DEFERRED_TO_MARKETING_V26/);
  assert.match(v26, /continuation_question_deferred_until_marketing_resolution: true/);

  const boundaryStart = v26.indexOf("private installPostToolResponseBoundaryV26");
  const fetchStart = v26.indexOf("async fetch(", boundaryStart);
  assert.ok(boundaryStart >= 0 && fetchStart > boundaryStart, "post-tool boundary must be defined before fetch");
  const boundary = v26.slice(boundaryStart, fetchStart);
  assert.doesNotMatch(boundary, /setTimeout|sleep\s*\(/);
});

test("v26 does not move post-tool policy into direct business executors", async () => {
  const v19 = await source("call-session-v19.ts");
  const v23 = await source("call-session-v23.ts");
  const v24 = await source("call-session-v24.ts");

  assert.doesNotMatch(v19, /DIRECT_POST_TOOL_RESPONSE_GOVERNED_V26/);
  assert.doesNotMatch(v23, /DIRECT_POST_TOOL_RESPONSE_GOVERNED_V26/);
  assert.doesNotMatch(v24, /DIRECT_POST_TOOL_RESPONSE_GOVERNED_V26/);
});
