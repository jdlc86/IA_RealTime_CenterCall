import assert from "node:assert/strict";
import test from "node:test";
import {
  externalRealtimeProviderCommandPortFor,
  installExternalRealtimeProviderCommandPort,
  removeExternalRealtimeProviderCommandPort,
} from "../.test-dist/realtime-provider-external-command-runtime.js";

function fakePort(label) {
  return {
    label,
    speak() {}, requestTextDecision() {}, createSemanticResponse() {}, submitToolResult() {},
    updateSessionPolicy() {}, setSemanticToolGate() {}, createDefaultResponse() {}, cancelResponse() {},
    clearPlayback() {}, clearInput() {}, discardInputItem() {}, suspendInputDetection() {},
    beginNonInterruptingListening() {}, restoreInputDetection() {},
  };
}

test("external command capability installs and releases with provider affinity", () => {
  const host = {};
  const port = fakePort("gemini");
  installExternalRealtimeProviderCommandPort(host, "GEMINI", port);
  assert.equal(externalRealtimeProviderCommandPortFor(host, "GEMINI"), port);
  removeExternalRealtimeProviderCommandPort(host, "GEMINI", port);
  assert.equal(externalRealtimeProviderCommandPortFor(host, "GEMINI"), null);
});

test("external command capability fails closed on affinity or ownership mismatch", () => {
  const host = {};
  const first = fakePort("first");
  const second = fakePort("second");
  installExternalRealtimeProviderCommandPort(host, "GEMINI", first);
  assert.throws(() => externalRealtimeProviderCommandPortFor(host, "OPENAI"), /affinity mismatch/);
  assert.throws(() => installExternalRealtimeProviderCommandPort(host, "GEMINI", second), /already installed/);
  assert.throws(() => removeExternalRealtimeProviderCommandPort(host, "GEMINI", second), /ownership mismatch/);
});
