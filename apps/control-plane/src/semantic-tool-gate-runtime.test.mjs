import assert from "node:assert/strict";
import test from "node:test";
import {
  installSemanticToolGatePort,
  removeSemanticToolGatePort,
  semanticToolGatePortFor,
} from "../.test-dist/semantic-tool-gate-runtime.js";

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

test("external semantic tool gate overrides realtime enforcement only for its session", () => {
  const h = host();
  const effects = [];
  const external = {
    arm() { effects.push("ARM"); },
    release() { effects.push("RELEASE"); },
  };

  const fallback = semanticToolGatePortFor(h);
  installSemanticToolGatePort(h, external);
  const gate = semanticToolGatePortFor(h);
  assert.equal(gate, external);
  gate.arm();
  gate.release();
  assert.deepEqual(effects, ["ARM", "RELEASE"]);
  assert.deepEqual(h.events, []);

  removeSemanticToolGatePort(h, external);
  assert.equal(semanticToolGatePortFor(h), fallback);
});

test("external semantic tool gate ownership is fail-closed", () => {
  const h = host();
  const first = { arm() {}, release() {} };
  const second = { arm() {}, release() {} };

  installSemanticToolGatePort(h, first);
  assert.doesNotThrow(() => installSemanticToolGatePort(h, first));
  assert.throws(() => installSemanticToolGatePort(h, second), /already installed/);
  assert.throws(() => removeSemanticToolGatePort(h, second), /ownership mismatch/);
  assert.equal(semanticToolGatePortFor(h), first);
  removeSemanticToolGatePort(h, first);
});
