import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./call-session-v53-reservation-time-authority.ts", import.meta.url), "utf8");

test("V53 advances the governed post-tool response boundary after blocking an unproven time", () => {
  const methodStart = source.indexOf("private rejectUnprovenTimeV53");
  const methodEnd = source.indexOf("private async handleRealtimeMessage", methodStart);
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
