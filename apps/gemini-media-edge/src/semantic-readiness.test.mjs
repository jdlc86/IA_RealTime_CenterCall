import test from "node:test";
import assert from "node:assert/strict";
import { runSemanticDecisionReadinessProbe, semanticDecisionFailureCategory } from "./semantic-readiness.mjs";

function readyLiveProviderProbe(calls = []) {
  return async (options) => {
    calls.push(options);
    return { status: "ready", expectedTool: "restaurant_reservation_create" };
  };
}

test("semantic readiness gates on both structured classifier and real Live function-calling contracts", async () => {
  const calls = [];
  const liveCalls = [];
  const result = await runSemanticDecisionReadinessProbe({
    async decide(request) {
      calls.push(request);
      return JSON.stringify({ selectedTool: "restaurant_conversation" });
    },
  }, {
    liveProviderProbe: readyLiveProviderProbe(liveCalls),
    liveProviderOptions: { apiKey: "synthetic-secret", model: "gemini-live-model" },
  });
  assert.deepEqual(result, { status: "ready", liveProviderContract: "ready" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inputText, "hola");
  assert.equal(calls[0].responseMimeType, "application/json");
  assert.equal(calls[0].responseJsonSchema.properties.selectedTool.enum[0], "restaurant_conversation");
  assert.deepEqual(liveCalls, [{ apiKey: "synthetic-secret", model: "gemini-live-model" }]);
});

test("semantic readiness reports bounded classifier provider categories without provider body or prompt content", async () => {
  const forbidden = "provider-secret-body";
  const result = await runSemanticDecisionReadinessProbe({
    async decide() { throw new Error(`Gemini isolated decision request failed with HTTP 403 ${forbidden}`); },
  }, { liveProviderProbe: readyLiveProviderProbe() });
  assert.deepEqual(result, { status: "failed", failureCategory: "PROVIDER_HTTP_403" });
  assert.equal(JSON.stringify(result).includes(forbidden), false);
});

test("semantic readiness fails closed on categorical Live provider contract failures without raw provider content", async () => {
  const result = await runSemanticDecisionReadinessProbe({
    async decide() { return JSON.stringify({ selectedTool: "restaurant_conversation" }); },
  }, {
    liveProviderProbe: async () => ({ status: "failed", failureCategory: "DIRECT_OUTPUT_BEFORE_TOOL_CALL", raw: "never-propagate" }),
  });
  assert.deepEqual(result, { status: "failed", failureCategory: "LIVE_PROVIDER_DIRECT_OUTPUT_BEFORE_TOOL_CALL" });
  assert.equal(JSON.stringify(result).includes("never-propagate"), false);
});

test("semantic readiness distinguishes transport and malformed classifier output", async () => {
  assert.equal(semanticDecisionFailureCategory(new Error("Gemini isolated decision request failed")), "PROVIDER_TRANSPORT");
  assert.deepEqual(
    await runSemanticDecisionReadinessProbe({ async decide() { return "not-json"; } }, { liveProviderProbe: readyLiveProviderProbe() }),
    { status: "failed", failureCategory: "PROBE_RESPONSE_INVALID" },
  );
  assert.deepEqual(
    await runSemanticDecisionReadinessProbe({ async decide() { return JSON.stringify({ selectedTool: "wrong" }); } }, { liveProviderProbe: readyLiveProviderProbe() }),
    { status: "failed", failureCategory: "PROBE_RESPONSE_INVALID" },
  );
});
