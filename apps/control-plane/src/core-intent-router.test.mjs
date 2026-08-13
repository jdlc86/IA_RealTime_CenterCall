import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCoreIntentRequest, coreIntentClassifierTool } from "../.test-dist/core-intent-router.js";

test("parses reservation create as one top-level workflow", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({ intent: "CREATE_RESERVATION" })), {
    intent: "CREATE_RESERVATION",
  });
});

test("parses business info with several topics", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({
    intent: "BUSINESS_INFO",
    auxiliary: true,
    business_info: { topics: ["HOURS", "MENU"] },
  })), {
    intent: "BUSINESS_INFO",
    auxiliary: true,
    businessInfoTopics: ["HOURS", "MENU"],
  });
});

test("business info without an explicit topic fails closed", () => {
  assert.throws(() => parseCoreIntentRequest(JSON.stringify({ intent: "BUSINESS_INFO" })), /requires explicit topics/);
});

test("pure close rejection may use topic-less business info only as neutral carrier", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({
    intent: "BUSINESS_INFO",
    closing_response: "REJECT",
  })), {
    intent: "BUSINESS_INFO",
    auxiliary: false,
    businessInfoTopics: ["GENERAL_INFO"],
    closingResponse: "REJECT",
  });
});

test("parses out of scope as a dedicated non-business intent", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({ intent: "OUT_OF_SCOPE" })), {
    intent: "OUT_OF_SCOPE",
  });
});

test("classifier contract fails closed toward out of scope on domain ambiguity", () => {
  const tool = coreIntentClassifierTool();
  const intent = tool.parameters.properties.intent;
  assert.ok(intent.enum.includes("OUT_OF_SCOPE"));
  assert.match(tool.description, /qué es un barco/);
  assert.match(tool.description, /Ante duda entre BUSINESS_INFO y OUT_OF_SCOPE, elige OUT_OF_SCOPE/);
  assert.match(tool.description, /GENERAL_INFO significa hechos del establecimiento actual, no conocimiento general/);
  assert.deepEqual(tool.parameters.properties.business_info.required, ["topics"]);
});

test("parses explicit rejection of a pending close without changing workflow intent", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({
    intent: "CREATE_RESERVATION",
    closing_response: "REJECT",
  })), {
    intent: "CREATE_RESERVATION",
    closingResponse: "REJECT",
  });
});

test("parses explicit confirmation of close", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({
    intent: "CLOSING",
    closing_response: "CONFIRM",
  })), {
    intent: "CLOSING",
    closingResponse: "CONFIRM",
  });
});

test("rejects unknown closing response fail closed", () => {
  assert.throws(() => parseCoreIntentRequest(JSON.stringify({
    intent: "CREATE_RESERVATION",
    closing_response: "MAYBE",
  })));
});

test("rejects unknown top-level intents fail closed", () => {
  assert.throws(() => parseCoreIntentRequest(JSON.stringify({ intent: "BOOKED" })));
});

test("rejects invalid business info topics", () => {
  assert.throws(() => parseCoreIntentRequest(JSON.stringify({
    intent: "BUSINESS_INFO",
    business_info: { topics: ["HOURS", "RESERVATION"] },
  })));
});

test("malformed classifier JSON is rejected deterministically", () => {
  assert.throws(() => parseCoreIntentRequest('{"intent":"BUSINESS_INFO","business_info":{"topics":["MENU"]}'), SyntaxError);
});
