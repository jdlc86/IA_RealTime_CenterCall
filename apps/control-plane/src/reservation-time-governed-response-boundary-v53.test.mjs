import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./call-session-v53-reservation-time-authority.ts", import.meta.url), "utf8");

test("V53 advances the governed post-tool response boundary after blocking an unproven time", () => {
  const methodStart = source.indexOf("private rejectUnprovenTimeV53");
  const methodEnd = source.indexOf("private consumeAuthorizedTimeV53", methodStart);
  assert.ok(methodStart >= 0 && methodEnd > methodStart, "rejectUnprovenTimeV53 must exist");

  const method = source.slice(methodStart, methodEnd);
  const port = method.indexOf("const realtime = realtimeCommandPortFor(this as any)");
  const submit = method.indexOf("realtime.submitToolResult(");
  const create = method.indexOf("realtime.createDefaultResponse()");

  assert.ok(port >= 0, "V53 must use one provider-neutral command port instance");
  assert.ok(submit > port, "V53 must submit the structured MISSING_INFORMATION result first");
  assert.ok(create > submit, "V53 must advance the default-response boundary after the tool result");
  assert.doesNotMatch(method, /setTimeout|sleep\s*\(|delay\s*\(/);
});

test("V53 consumes blocked-tool authority through the shared semantic authorization port", () => {
  const start = source.indexOf("private consumeBlockedToolAuthorityV53");
  const end = source.indexOf("private rejectUnprovenTimeV53", start);
  assert.ok(start >= 0 && end > start, "consumeBlockedToolAuthorityV53 must exist");
  const method = source.slice(start, end);

  assert.match(source, /publicRestaurantToolAuthorizationPortFor/);
  assert.match(method, /publicRestaurantToolAuthorizationPortFor\(this\)\.decide/);
  assert.match(method, /result\.allowed && !result\.ignored && !result\.directedIgnoreRejected/);
  assert.match(method, /semantic_authority_owner: "semantic_tool_authorization_port"/);
  assert.doesNotMatch(source, /authorizePublicRestaurantTool\(/);
  assert.doesNotMatch(source, /from "\.\/semantic-turn-coordinator\.js"/);
});
