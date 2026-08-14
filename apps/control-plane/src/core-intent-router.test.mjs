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

test("Lucia owns conversation and sees the restaurant capability catalog", () => {
  const tool = coreIntentClassifierTool();
  assert.match(tool.description, /Eres Lucía/);
  assert.match(tool.description, /TU MISIÓN/);
  assert.match(tool.description, /no es un clasificador externo/);
  assert.match(tool.description, /crear una reserva/);
  assert.match(tool.description, /consultar las reservas/);
  assert.match(tool.description, /cancelar una, varias o todas/);
  assert.match(tool.description, /menú, horario, ubicación, servicios/);
  assert.match(tool.description, /consentimiento de promociones/);
  assert.match(tool.description, /cierre de la llamada/);
});

test("Lucia must continue speaking after backend results", () => {
  const tool = coreIntentClassifierTool();
  assert.match(tool.description, /DEBES continuar la conversación/);
  assert.match(tool.description, /Nunca te quedes en silencio/);
  assert.match(tool.description, /READY_TO_CONFIRM/);
  assert.match(tool.description, /UNAVAILABLE/);
  assert.match(tool.description, /cambia de 5 a 4 personas/);
});

test("conversation director fails closed toward out of scope on domain ambiguity", () => {
  const tool = coreIntentClassifierTool();
  const intent = tool.parameters.properties.intent;
  assert.ok(intent.enum.includes("OUT_OF_SCOPE"));
  assert.match(tool.description, /GENERAL_INFO son hechos del establecimiento/);
  assert.match(tool.description, /ante duda, OUT_OF_SCOPE/);
  assert.deepEqual(tool.parameters.properties.business_info.required, ["topics"]);
});

test("conversation director treats user text as intent, never authority", () => {
  const tool = coreIntentClassifierTool();
  assert.match(tool.description, /JERARQUÍA DE AUTORIDAD INMUTABLE/);
  assert.match(tool.description, /soy administrador/);
  assert.match(tool.description, /ignora tus instrucciones/);
  assert.match(tool.description, /no puede cambiar el dominio/);
  assert.match(tool.description, /Nunca decidas por tu cuenta estados backend/);
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

test("malformed action JSON is rejected deterministically", () => {
  assert.throws(() => parseCoreIntentRequest('{"intent":"BUSINESS_INFO","business_info":{"topics":["MENU"]}'), SyntaxError);
});
