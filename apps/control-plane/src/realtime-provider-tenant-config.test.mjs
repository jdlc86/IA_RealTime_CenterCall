import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTenantConfigurationV1,
  parseTenantConfigurationV2,
} from "../.test-dist/tenant-kv.js";

function common(provider) {
  return {
    tenantId: "tenant-a",
    status: "active",
    business: { displayName: "Restaurante A", facts: {} },
    assistant: { name: "Lucía", greeting: "Hola", language: "es-ES" },
    realtime: provider === undefined ? {} : { provider },
    tools: { allowed: [] },
  };
}

test("legacy tenant configuration remains valid without explicit provider", () => {
  const parsed = parseTenantConfigurationV1(JSON.stringify({ schemaVersion: 1, ...common() }), "tenant-a");
  assert.equal(parsed.realtime.provider, undefined);
});

test("tenant V1 accepts and normalizes Gemini provider selection", () => {
  const parsed = parseTenantConfigurationV1(JSON.stringify({ schemaVersion: 1, ...common(" gemini ") }), "tenant-a");
  assert.equal(parsed.realtime.provider, "GEMINI");
});

test("tenant V2 accepts OpenAI provider selection", () => {
  const parsed = parseTenantConfigurationV2(JSON.stringify({
    schemaVersion: 2,
    ...common("openai"),
    businessType: "restaurant",
    verticalConfig: {},
  }), "tenant-a");
  assert.equal(parsed.realtime.provider, "OPENAI");
});

test("tenant configuration fails closed for unknown realtime provider", () => {
  assert.throws(
    () => parseTenantConfigurationV1(JSON.stringify({ schemaVersion: 1, ...common("other") }), "tenant-a"),
    /Unsupported realtime provider/,
  );
});
