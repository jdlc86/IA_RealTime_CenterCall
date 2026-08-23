import assert from "node:assert/strict";
import test from "node:test";
import { createRealtimeBackedSemanticToolGatePort } from "../.test-dist/semantic-tool-gate-port.js";

function fakeRealtime() {
  const gates = [];
  const policies = [];
  return {
    gates,
    policies,
    speak() {},
    requestTextDecision() {},
    createSemanticResponse() {},
    submitToolResult() {},
    updateSessionPolicy(update) { policies.push(update); },
    setSemanticToolGate(armed) { gates.push(armed); },
    createDefaultResponse() {},
    cancelResponse() {},
    clearPlayback() {},
    clearInput() {},
    discardInputItem() {},
    suspendInputDetection() {},
    beginNonInterruptingListening() {},
    restoreInputDetection() {},
  };
}

test("OpenAI semantic tool gate uses the neutral gate command rather than session policy", () => {
  const realtime = fakeRealtime();
  const gate = createRealtimeBackedSemanticToolGatePort("OPENAI", realtime);
  gate.arm();
  gate.release();
  assert.deepEqual(realtime.gates, [true, false]);
  assert.deepEqual(realtime.policies, []);
});

test("Gemini cannot silently emulate the semantic gate through unsupported Live session mutation", () => {
  const realtime = fakeRealtime();
  const gate = createRealtimeBackedSemanticToolGatePort("GEMINI", realtime);
  assert.throws(() => gate.arm(), /GEMINI lacks required capabilities: semanticToolGate/);
  assert.throws(() => gate.release(), /GEMINI lacks required capabilities: semanticToolGate/);
  assert.deepEqual(realtime.gates, []);
  assert.deepEqual(realtime.policies, []);
});
