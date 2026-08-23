import assert from "node:assert/strict";
import test from "node:test";
import { semanticToolGatePortFor } from "../.test-dist/semantic-tool-gate-runtime.js";

function host() {
  const events = [];
  return {
    events,
    send(event) { events.push(event); },
  };
}

test("semantic tool gate capability is stable per session host", () => {
  const h = host();
  assert.equal(semanticToolGatePortFor(h), semanticToolGatePortFor(h));
  assert.notEqual(semanticToolGatePortFor(h), semanticToolGatePortFor(host()));
});

test("current OpenAI baseline preserves exact semantic gate session policy wire", () => {
  const h = host();
  const gate = semanticToolGatePortFor(h);
  gate.arm();
  gate.release();
  assert.deepEqual(h.events, [
    { type: "session.update", session: { type: "realtime", tool_choice: "required" } },
    { type: "session.update", session: { type: "realtime", tool_choice: "auto" } },
  ]);
});
