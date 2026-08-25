import test from "node:test";
import assert from "node:assert/strict";
import { runSemanticDecisionReadinessProbe, semanticDecisionFailureCategory } from "./semantic-readiness.mjs";

test("semantic readiness exercises the real structured one-shot contract with fixed non-PII input", async () => {
  const calls = [];
  const result = await runSemanticDecisionReadinessProbe({
    async decide(request) {
      calls.push(request);
      return JSON.stringify({ selectedTool: "restaurant_conversation" });
    },
  });
  assert.deepEqual(result, { status: "ready" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inputText, "hola");
  assert.equal(calls[0].responseMimeType, "application/json");
  assert.equal(calls[0].responseJsonSchema.properties.selectedTool.enum[0], "restaurant_conversation");
});

test("semantic readiness reports bounded provider categories without provider body or prompt content", async () => {
  const forbidden = "provider-secret-body";
  const result = await runSemanticDecisionReadinessProbe({
    async decide() { throw new Error(`Gemini isolated decision request failed with HTTP 403 ${forbidden}`); },
  });
  assert.deepEqual(result, { status: "failed", failureCategory: "PROVIDER_HTTP_403" });
  assert.equal(JSON.stringify(result).includes(forbidden), false);
});

test("semantic readiness distinguishes transport and malformed provider output", async () => {
  assert.equal(semanticDecisionFailureCategory(new Error("Gemini isolated decision request failed")), "PROVIDER_TRANSPORT");
  assert.deepEqual(
    await runSemanticDecisionReadinessProbe({ async decide() { return "not-json"; } }),
    { status: "failed", failureCategory: "PROBE_RESPONSE_INVALID" },
  );
  assert.deepEqual(
    await runSemanticDecisionReadinessProbe({ async decide() { return JSON.stringify({ selectedTool: "wrong" }); } }),
    { status: "failed", failureCategory: "PROBE_RESPONSE_INVALID" },
  );
});
