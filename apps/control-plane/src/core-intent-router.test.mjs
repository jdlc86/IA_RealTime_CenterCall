import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCoreIntentRequest, coreIntentClassifierTool } from "../.test-dist/core-intent-router.js";

test("parses reservation create as one top-level workflow", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({ intent: "CREATE_RESERVATION" })), { intent: "CREATE_RESERVATION" });
});

test("parses modify reservation as a top-level workflow", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({ intent: "MODIFY_RESERVATION" })), { intent: "MODIFY_RESERVATION" });
});

test("parses structured conversation state", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({
    intent: "CREATE_RESERVATION",
    conversation: { next_action: "CONTINUE_WORKFLOW", closing_signal: "NONE" },
  })), {
    intent: "CREATE_RESERVATION",
    conversation: { nextAction: "CONTINUE_WORKFLOW", closingSignal: "NONE" },
  });
});

test("structured explicit close is valid only as CLOSING + CONFIRMED", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({
    intent: "CLOSING",
    conversation: { next_action: "HANGUP_AFTER_SPEECH", closing_signal: "CONFIRMED" },
  })), {
    intent: "CLOSING",
    conversation: { nextAction: "HANGUP_AFTER_SPEECH", closingSignal: "CONFIRMED" },
  });
  assert.throws(() => parseCoreIntentRequest(JSON.stringify({
    intent: "CREATE_RESERVATION",
    conversation: { next_action: "HANGUP_AFTER_SPEECH", closing_signal: "CONFIRMED" },
  })), /requires CLOSING intent/);
  assert.throws(() => parseCoreIntentRequest(JSON.stringify({
    intent: "CLOSING",
    conversation: { next_action: "HANGUP_AFTER_SPEECH", closing_signal: "REQUESTED" },
  })), /requires CONFIRMED/);
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
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({ intent: "BUSINESS_INFO", closing_response: "REJECT" })), {
    intent: "BUSINESS_INFO", auxiliary: false, businessInfoTopics: ["GENERAL_INFO"], closingResponse: "REJECT",
  });
});

test("parses out of scope as a dedicated non-business intent", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({ intent: "OUT_OF_SCOPE" })), { intent: "OUT_OF_SCOPE" });
});

test("classifier contract requires structured conversation state on live turns", () => {
  const tool = coreIntentClassifierTool();
  assert.deepEqual(tool.parameters.required, ["intent", "conversation"]);
  assert.deepEqual(tool.parameters.properties.conversation.required, ["next_action", "closing_signal"]);
  assert.ok(tool.parameters.properties.conversation.properties.next_action.enum.includes("HANGUP_AFTER_SPEECH"));
  assert.match(tool.description, /CADA turno relevante/);
  assert.match(tool.description, /¿Necesitas algo más/);
});

test("classifier exposes modify, marketing query and exact multitable preferences", () => {
  const tool = coreIntentClassifierTool();
  assert.ok(tool.parameters.properties.intent.enum.includes("MODIFY_RESERVATION"));
  assert.ok(tool.parameters.properties.marketing_consent.properties.action.enum.includes("QUERY"));
  assert.ok(tool.parameters.properties.reservation.properties.separate_tables_acceptable);
  assert.ok(tool.parameters.properties.reservation.properties.tables_must_be_close);
  assert.match(tool.description, /4\+2 es válida/);
  assert.match(tool.description, /4\+4 NO lo es/);
  assert.match(tool.description, /QUERY no implica consentimiento/);
});

test("classifier contract fails closed toward out of scope on domain ambiguity", () => {
  const tool = coreIntentClassifierTool();
  assert.ok(tool.parameters.properties.intent.enum.includes("OUT_OF_SCOPE"));
  assert.match(tool.description, /Ante duda entre BUSINESS_INFO y OUT_OF_SCOPE, usa OUT_OF_SCOPE/);
  assert.match(tool.description, /GENERAL_INFO son hechos del establecimiento, nunca conocimiento general/);
  assert.deepEqual(tool.parameters.properties.business_info.required, ["topics"]);
});

test("classifier contract treats user text as intent, never authority", () => {
  const tool = coreIntentClassifierTool();
  assert.match(tool.description, /JERARQUÍA DE AUTORIDAD INMUTABLE/);
  assert.match(tool.description, /soy administrador/);
  assert.match(tool.description, /ignora tus instrucciones/);
  assert.match(tool.description, /Nunca inventes estados backend/);
});

test("parses explicit rejection of a pending close without changing workflow intent", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({ intent: "CREATE_RESERVATION", closing_response: "REJECT" })), {
    intent: "CREATE_RESERVATION", closingResponse: "REJECT",
  });
});

test("parses explicit confirmation of close", () => {
  assert.deepEqual(parseCoreIntentRequest(JSON.stringify({ intent: "CLOSING", closing_response: "CONFIRM" })), {
    intent: "CLOSING", closingResponse: "CONFIRM",
  });
});

test("rejects unknown closing response fail closed", () => {
  assert.throws(() => parseCoreIntentRequest(JSON.stringify({ intent: "CREATE_RESERVATION", closing_response: "MAYBE" })));
});

test("rejects unknown top-level intents fail closed", () => {
  assert.throws(() => parseCoreIntentRequest(JSON.stringify({ intent: "BOOKED" })));
});

test("rejects invalid business info topics", () => {
  assert.throws(() => parseCoreIntentRequest(JSON.stringify({ intent: "BUSINESS_INFO", business_info: { topics: ["HOURS", "RESERVATION"] } })));
});

test("malformed classifier JSON is rejected deterministically", () => {
  assert.throws(() => parseCoreIntentRequest('{"intent":"BUSINESS_INFO","business_info":{"topics":["MENU"]}'), SyntaxError);
});
