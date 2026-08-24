import assert from "node:assert/strict";
import test from "node:test";
import {
  installGovernedSpeechPort,
  removeGovernedSpeechPort,
  withGovernedSpeechPort,
} from "../.test-dist/governed-speech-runtime.js";

function commandHarness() {
  const calls = [];
  const port = {
    speak(request) { calls.push(["speak", request]); },
    requestTextDecision(request) { calls.push(["requestTextDecision", request]); },
    createSemanticResponse(request) { calls.push(["createSemanticResponse", request]); },
    submitToolResult(request) { calls.push(["submitToolResult", request]); },
    updateSessionPolicy(update) { calls.push(["updateSessionPolicy", update]); },
    setSemanticToolGate(armed) { calls.push(["setSemanticToolGate", armed]); },
    createDefaultResponse() { calls.push(["createDefaultResponse"]); },
    cancelResponse(responseId) { calls.push(["cancelResponse", responseId]); },
    clearPlayback() { calls.push(["clearPlayback"]); },
    clearInput() { calls.push(["clearInput"]); },
    discardInputItem(itemId) { calls.push(["discardInputItem", itemId]); },
    suspendInputDetection() { calls.push(["suspendInputDetection"]); },
    beginNonInterruptingListening(settings) { calls.push(["beginNonInterruptingListening", settings]); },
    restoreInputDetection(settings) { calls.push(["restoreInputDetection", settings]); },
  };
  return { calls, port };
}

test("governed speech overrides only speech for exactly one session", () => {
  const host = {};
  const otherHost = {};
  const base = commandHarness();
  const otherBase = commandHarness();
  const speech = [];
  const external = { speak(request) { speech.push(request); } };
  const governed = withGovernedSpeechPort(host, "OPENAI", base.port);
  const other = withGovernedSpeechPort(otherHost, "OPENAI", otherBase.port);

  installGovernedSpeechPort(host, "OPENAI", external);
  governed.speak({ instructions: "governed", requestId: "speech-1" });
  governed.clearInput();
  other.speak({ instructions: "fallback" });

  assert.deepEqual(speech, [{ instructions: "governed", requestId: "speech-1" }]);
  assert.deepEqual(base.calls, [["clearInput"]]);
  assert.deepEqual(otherBase.calls, [["speak", { instructions: "fallback" }]]);

  removeGovernedSpeechPort(host, "OPENAI", external);
  governed.speak({ instructions: "fallback-after-remove" });
  assert.deepEqual(base.calls.at(-1), ["speak", { instructions: "fallback-after-remove" }]);
});

test("governed speech ownership and provider affinity fail closed", () => {
  const host = {};
  const first = { speak() {} };
  const second = { speak() {} };
  const base = commandHarness();
  const geminiView = withGovernedSpeechPort(host, "GEMINI", base.port);

  installGovernedSpeechPort(host, "OPENAI", first);
  assert.doesNotThrow(() => installGovernedSpeechPort(host, "OPENAI", first));
  assert.throws(() => installGovernedSpeechPort(host, "OPENAI", second), /already installed/);
  assert.throws(() => removeGovernedSpeechPort(host, "GEMINI", first), /ownership mismatch/);
  assert.throws(() => geminiView.speak({ instructions: "wrong provider" }), /affinity mismatch/);
  removeGovernedSpeechPort(host, "OPENAI", first);
});
