import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSemanticDecision } from "../dist-test/semantic-router.js";

test("valid services route", () => {
  assert.deepEqual(parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", data_requirement: "SERVICES", reason: "service query" })), {
    intent: "CONTINUE",
    dataRequirement: "SERVICES",
    reason: "service query",
    degraded: false,
  });
});

test("missing data requirement fails closed to business info", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", reason: "partial" }));
  assert.equal(result.intent, "CONTINUE");
  assert.equal(result.dataRequirement, "BUSINESS_INFO");
  assert.equal(result.degraded, true);
});

test("camelCase dataRequirement is accepted", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", dataRequirement: "HOURS" }));
  assert.equal(result.dataRequirement, "HOURS");
  assert.equal(result.degraded, false);
});

test("invalid JSON never returns null", () => {
  const result = parseSemanticDecision("{bad json");
  assert.equal(result.intent, "CONTINUE");
  assert.equal(result.dataRequirement, "BUSINESS_INFO");
  assert.equal(result.degraded, true);
});

test("empty output never returns null", () => {
  const result = parseSemanticDecision(undefined);
  assert.equal(result.intent, "CONTINUE");
  assert.equal(result.dataRequirement, "BUSINESS_INFO");
  assert.equal(result.degraded, true);
});

test("unknown intent fails closed without silence", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "UNKNOWN", data_requirement: "SERVICES" }));
  assert.equal(result.intent, "CONTINUE");
  assert.equal(result.dataRequirement, "SERVICES");
  assert.equal(result.degraded, true);
});

test("end intent always forces NONE", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "END_CLEAR", data_requirement: "SERVICES" }));
  assert.equal(result.intent, "END_CLEAR");
  assert.equal(result.dataRequirement, "NONE");
});
