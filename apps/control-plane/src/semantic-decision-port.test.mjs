import assert from "node:assert/strict";
import test from "node:test";
import { createRealtimeBackedSemanticDecisionPort } from "../.test-dist/semantic-decision-port.js";

function fakeRealtime() {
  const decisions = [];
  return {
    decisions,
    speak() {},
    requestTextDecision(request) { decisions.push(request); },
    createSemanticResponse() {},
    submitToolResult() {},
    updateSessionPolicy() {},
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

test("OpenAI may satisfy isolated semantic decisions through its validated realtime capability", () => {
  const realtime = fakeRealtime();
  const port = createRealtimeBackedSemanticDecisionPort("OPENAI", realtime);
  port.request({
    instructions: "Return CLOSE or CONTINUE only",
    inputText: "No, gracias",
    requestId: "decision-1",
    purpose: "contextual_close",
  });
  assert.equal(realtime.decisions.length, 1);
  assert.equal(realtime.decisions[0].requestId, "decision-1");
});

test("Gemini Live cannot be used as an isolated decision transport before that capability is proven", () => {
  const realtime = fakeRealtime();
  const port = createRealtimeBackedSemanticDecisionPort("GEMINI", realtime);
  assert.throws(
    () => port.request({
      instructions: "Return CLOSE or CONTINUE only",
      inputText: "No, gracias",
      requestId: "decision-gemini",
    }),
    /GEMINI lacks required capabilities: isolatedTextDecision/,
  );
  assert.deepEqual(realtime.decisions, []);
});

test("decision capability carries controller input separately from conversational transport", () => {
  const realtime = fakeRealtime();
  const port = createRealtimeBackedSemanticDecisionPort("OPENAI", realtime);
  const request = {
    instructions: "Classify the supplied text without speaking to the caller",
    inputText: "Quiero otra cosa",
    metadata: { authority: "controller" },
  };
  port.request(request);
  assert.deepEqual(realtime.decisions, [request]);
});
