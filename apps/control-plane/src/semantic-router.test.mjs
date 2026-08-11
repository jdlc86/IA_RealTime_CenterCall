import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSemanticDecision } from "../.test-dist/semantic-router.js";

test("valid services route", () => {
  assert.deepEqual(parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", data_requirement: "SERVICES", reason: "service query" })), { intent: "CONTINUE", dataRequirement: "SERVICES", reason: "service query", degraded: false });
});

test("valid restaurant menu route", () => {
  assert.deepEqual(parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", data_requirement: "MENU", reason: "menu query" })), { intent: "CONTINUE", dataRequirement: "MENU", reason: "menu query", degraded: false });
});

test("missing data requirement fails closed to business info", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", reason: "partial" }));
  assert.equal(result.intent, "CONTINUE"); assert.equal(result.dataRequirement, "BUSINESS_INFO"); assert.equal(result.degraded, true);
});

test("camelCase dataRequirement is accepted", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", dataRequirement: "HOURS" }));
  assert.equal(result.dataRequirement, "HOURS"); assert.equal(result.degraded, false);
});

test("invalid JSON never returns null", () => {
  const result = parseSemanticDecision("{bad json"); assert.equal(result.intent, "CONTINUE"); assert.equal(result.dataRequirement, "BUSINESS_INFO"); assert.equal(result.degraded, true);
});

test("empty output never returns null", () => {
  const result = parseSemanticDecision(undefined); assert.equal(result.intent, "CONTINUE"); assert.equal(result.dataRequirement, "BUSINESS_INFO"); assert.equal(result.degraded, true);
});

test("unknown intent fails closed without silence", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "UNKNOWN", data_requirement: "SERVICES" })); assert.equal(result.intent, "CONTINUE"); assert.equal(result.dataRequirement, "SERVICES"); assert.equal(result.degraded, true);
});

test("end intent always forces NONE", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "END_CLEAR", data_requirement: "SERVICES" })); assert.equal(result.intent, "END_CLEAR"); assert.equal(result.dataRequirement, "NONE");
});

test("NONE with treatment reason recovers SERVICES", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", data_requirement: "NONE", reason: "El usuario pregunta qué tratamientos ofrece la clínica" })); assert.equal(result.dataRequirement, "SERVICES"); assert.equal(result.degraded, true);
});

test("NONE with catalog reason recovers SERVICES", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", data_requirement: "NONE", reason: "Pregunta por el catálogo de servicios disponibles" })); assert.equal(result.dataRequirement, "SERVICES"); assert.equal(result.degraded, true);
});

test("NONE with botox price reason recovers SERVICES", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", data_requirement: "NONE", reason: "Quiere saber el precio del botox" })); assert.equal(result.dataRequirement, "SERVICES"); assert.equal(result.degraded, true);
});

test("NONE with restaurant menu reason recovers MENU", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", data_requirement: "NONE", reason: "Quiere consultar la carta y los platos del restaurante" })); assert.equal(result.dataRequirement, "MENU"); assert.equal(result.degraded, true);
});

test("restaurant allergens recover MENU", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", data_requirement: "BUSINESS_INFO", reason: "Pregunta por alérgenos de un plato" })); assert.equal(result.dataRequirement, "MENU"); assert.equal(result.degraded, true);
});

test("ordinary conversation remains NONE", () => {
  const result = parseSemanticDecision(JSON.stringify({ intent: "CONTINUE", data_requirement: "NONE", reason: "El usuario saluda y quiere continuar conversando" })); assert.equal(result.dataRequirement, "NONE"); assert.equal(result.degraded, false);
});
