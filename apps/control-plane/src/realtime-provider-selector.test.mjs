import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REALTIME_PROVIDER,
  ENABLED_REALTIME_PROVIDERS,
  REGISTERED_REALTIME_PROVIDERS,
  realtimeProviderOverrideKey,
  selectRealtimeProvider,
} from "../.test-dist/realtime-provider-selector.js";

class FakeKv {
  constructor(entries = {}) { this.entries = new Map(Object.entries(entries)); }
  async get(key) { return this.entries.get(key) ?? null; }
}

function tenant(tenantId = "restaurante-centro", provider) {
  return {
    schemaVersion: 1,
    tenantId,
    status: "active",
    business: { displayName: "Restaurante Centro", facts: {} },
    assistant: { name: "Lucía", greeting: "Hola", language: "es-ES" },
    realtime: provider ? { provider } : {},
    tools: { allowed: [] },
  };
}

test("G1 keeps OpenAI as the backward-compatible default while registering Gemini", async () => {
  const selected = await selectRealtimeProvider(tenant(), new FakeKv());
  assert.equal(DEFAULT_REALTIME_PROVIDER, "OPENAI");
  assert.deepEqual(REGISTERED_REALTIME_PROVIDERS, ["OPENAI", "GEMINI"]);
  assert.deepEqual(ENABLED_REALTIME_PROVIDERS, ["OPENAI"]);
  assert.equal(selected.provider, "OPENAI");
  assert.equal(selected.source, "DEFAULT");
});

test("G1 selects Gemini from tenant configuration without silently enabling traffic", async () => {
  const selected = await selectRealtimeProvider(tenant("tenant-gemini", "GEMINI"), new FakeKv());
  assert.equal(selected.provider, "GEMINI");
  assert.equal(selected.source, "TENANT_CONFIG");
});

test("G1 keeps operational KV override precedence over tenant configuration", async () => {
  const config = tenant("tenant-a", "GEMINI");
  const key = realtimeProviderOverrideKey(config.tenantId);
  const selected = await selectRealtimeProvider(config, new FakeKv({ [key]: " openai " }));
  assert.equal(selected.provider, "OPENAI");
  assert.equal(selected.source, "KV_OVERRIDE");
  assert.equal(selected.overrideKey, key);
});

test("G1 accepts a registered Gemini KV override as a selection, leaving enablement to composition", async () => {
  const config = tenant("tenant-a");
  const key = realtimeProviderOverrideKey(config.tenantId);
  const selected = await selectRealtimeProvider(config, new FakeKv({ [key]: " gemini " }));
  assert.equal(selected.provider, "GEMINI");
  assert.equal(selected.source, "KV_OVERRIDE");
});

test("G1 fails closed for an unknown provider instead of silently falling back", async () => {
  const config = tenant("tenant-a");
  const key = realtimeProviderOverrideKey(config.tenantId);
  await assert.rejects(
    () => selectRealtimeProvider(config, new FakeKv({ [key]: "UNKNOWN" })),
    /Unsupported realtime provider/,
  );
});

test("G1 provider override is namespaced per tenant", () => {
  assert.notEqual(realtimeProviderOverrideKey("tenant-a"), realtimeProviderOverrideKey("tenant-b"));
  assert.match(realtimeProviderOverrideKey("tenant-a"), /tenant-a$/);
});
