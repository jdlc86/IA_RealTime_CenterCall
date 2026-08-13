import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCoreIntentRequest } from "../.test-dist/core-intent-router.js";

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

test("business info without topic defaults to general info", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({ intent: "BUSINESS_INFO" })), {
    intent: "BUSINESS_INFO",
    auxiliary: false,
    businessInfoTopics: ["GENERAL_INFO"],
  });
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
