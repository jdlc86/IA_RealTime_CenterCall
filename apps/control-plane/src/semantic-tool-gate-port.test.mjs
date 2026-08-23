import assert from "node:assert/strict";
import test from "node:test";
import { createRealtimeBackedSemanticToolGatePort } from "../.test-dist/semantic-tool-gate-port.js";

function fakeRealtime() {
  const policies = [];
  return {
    policies,
    speak() {},
    requestTextDecision() {},
    createSemanticResponse() {},
    submitToolResult() {},
    updateSessionPolicy(update) { policies.push(update); },
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

test("OpenAI semantic tool gate preserves REQUIRED then AUTO enforcement", () => {
  const realtime = fakeRealtime();
  const gate = createRealtimeBackedSemanticToolGatePort("OPENAI", realtime);
  gate.arm();
  gate.release();
  assert.deepEqual(realtime.policies, [
    { toolChoice: "REQUIRED" },
    { toolChoice: "AUTO" },
  ]);
});

test("Gemini cannot silently emulate the semantic gate through unsupported Live session mutation", () => {
  const realtime = fakeRealtime();
  const gate = createRealtimeBackedSemanticToolGatePort("GEMINI", realtime);
  assert.throws(() => gate.arm(), /GEMINI lacks required capabilities: semanticToolGate/);
  assert.throws(() => gate.release(), /GEMINI lacks required capabilities: semanticToolGate/);
  assert.deepEqual(realtime.policies, []);
});
