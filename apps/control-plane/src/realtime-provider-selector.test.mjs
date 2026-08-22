import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REALTIME_PROVIDER,
  REGISTERED_REALTIME_PROVIDERS,
  realtimeProviderOverrideKey,
  selectRealtimeProvider,
} from "../.test-dist/realtime-provider-selector.js";

class FakeKv {
  constructor(entries = {}) { this.entries = new Map(Object.entries(entries)); }
  async get(key) { return this.entries.get(key) ?? null; }
}

function tenant(tenantId = "restaurante-centro") {
  return {
    schemaVersion: 1,
    tenantId,
    status: "active",
    business: { displayName: "Restaurante Centro", facts: {} },
    assistant: { name: "Lucía", greeting: "Hola", language: "es-ES" },
    realtime: {},
    tools: { allowed: [] },
  };
}

test("Gate A defaults every resolved tenant to the only registered provider", async () => {
  const selected = await selectRealtimeProvider(tenant(), new FakeKv());
  assert.equal(DEFAULT_REALTIME_PROVIDER, "OPENAI");
  assert.deepEqual(REGISTERED_REALTIME_PROVIDERS, ["OPENAI"]);
  assert.equal(selected.provider, "OPENAI");
  assert.equal(selected.source, "DEFAULT");
});

test("Gate A accepts an explicit OPENAI KV override without changing semantics", async () => {
  const config = tenant("tenant-a");
  const key = realtimeProviderOverrideKey(config.tenantId);
  const selected = await selectRealtimeProvider(config, new FakeKv({ [key]: " openai " }));
  assert.equal(selected.provider, "OPENAI");
  assert.equal(selected.source, "KV_OVERRIDE");
  assert.equal(selected.overrideKey, key);
});

test("Gate A fails closed for an unregistered provider instead of silently falling back", async () => {
  const config = tenant("tenant-a");
  const key = realtimeProviderOverrideKey(config.tenantId);
  await assert.rejects(
    () => selectRealtimeProvider(config, new FakeKv({ [key]: "GEMINI" })),
    /Unsupported realtime provider/,
  );
});

test("Gate A provider override is namespaced per tenant", () => {
  assert.notEqual(realtimeProviderOverrideKey("tenant-a"), realtimeProviderOverrideKey("tenant-b"));
  assert.match(realtimeProviderOverrideKey("tenant-a"), /tenant-a$/);
});
