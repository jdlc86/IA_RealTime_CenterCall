import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("v43 handoff confirmation is emitted once with tools disabled", async () => {
  const v43 = await source("call-session-v43-handoff-authorization.ts");

  assert.match(v43, /realtimeCommandPortFor/);
  assert.match(v43, /purpose: source === "CALLER_REJECTED"[\s\S]*"human_handoff_confirmation_v43"/);
  assert.match(v43, /tools: "DISABLED"/);
  assert.match(v43, /single_confirmation_prompt: source === "OFFER_REQUIRED"/);
  assert.match(v43, /confirmation_response_tools_disabled: true/);

  const start = v43.indexOf("private rejectUnauthorizedHandoffV43");
  const end = v43.indexOf("private consumeRejectedOfferMisclassifiedAsIgnoredV43", start);
  assert.ok(start >= 0 && end > start, "v43 unauthorized-handoff boundary must be present");
  const boundary = v43.slice(start, end);

  assert.doesNotMatch(boundary, /send\?\.\(\{ type: "response\.create" \}\)/);
  assert.match(boundary, /realtimeCommandPortFor\(session\)\.speak/);
  assert.match(boundary, /tools: "DISABLED"/);
});
