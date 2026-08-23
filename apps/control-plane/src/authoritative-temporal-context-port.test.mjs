import assert from "node:assert/strict";
import test from "node:test";
import { createRealtimeBackedAuthoritativeTemporalContextPort } from "../.test-dist/authoritative-temporal-context-port.js";

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

test("OpenAI temporal context preserves current authoritative instruction behavior behind the semantic port", () => {
  const realtime = fakeRealtime();
  const port = createRealtimeBackedAuthoritativeTemporalContextPort("OPENAI", realtime);
  port.refresh({
    baseInstructions: "Eres Lucía.",
    now: new Date("2026-08-23T11:05:00Z"),
  });

  assert.equal(realtime.policies.length, 1);
  assert.match(realtime.policies[0].instructions, /^Eres Lucía\./);
  assert.match(realtime.policies[0].instructions, /\[AUTHORITATIVE_NOW_V48\]/);
  assert.match(realtime.policies[0].instructions, /Europe\/Madrid/);
});

test("Gemini temporal context fails before writing to Live until a provider-specific strategy is proven", () => {
  const realtime = fakeRealtime();
  const port = createRealtimeBackedAuthoritativeTemporalContextPort("GEMINI", realtime);

  assert.throws(
    () => port.refresh({ baseInstructions: "Eres Lucía." }),
    /GEMINI lacks required capabilities: authoritativeTemporalContext/,
  );
  assert.deepEqual(realtime.policies, []);
});
