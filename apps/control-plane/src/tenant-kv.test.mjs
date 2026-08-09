import test from "node:test";
import assert from "node:assert/strict";
import {
  KvTenantRepository,
  phoneRouteKey,
  tenantConfigurationKey,
  parseTenantConfigurationV1,
} from "../.test-dist/tenant-kv.js";

class FakeKv {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
  }
  async get(key) {
    return this.entries.get(key) ?? null;
  }
}

function tenantConfig(tenantId, displayName, assistantName) {
  return JSON.stringify({
    schemaVersion: 1,
    tenantId,
    status: "active",
    business: { displayName, facts: { years_in_operation: 20 } },
    assistant: {
      name: assistantName,
      greeting: `Hola, soy ${assistantName}`,
      language: "es-ES",
    },
    realtime: { voice: "marin", vad: { threshold: 0.5 } },
    tools: { allowed: ["get_business_information"] },
  });
}

test("F4-KV01 phone route resolves the correct tenant", async () => {
  const kv = new FakeKv({
    [phoneRouteKey("+34910789057")]: JSON.stringify({ schemaVersion: 1, tenantId: "clinica-estetica-madrid", status: "active" }),
  });
  const repo = new KvTenantRepository(kv);
  const result = await repo.resolveByCalledNumber("+34 910 789 057");
  assert.equal(result?.tenantId, "clinica-estetica-madrid");
  assert.equal(result?.calledNumber, "+34910789057");
});

test("F4-KV02 unknown phone fails closed", async () => {
  const repo = new KvTenantRepository(new FakeKv());
  assert.equal(await repo.resolveByCalledNumber("+34999999999"), null);
});

test("F4-KV03 disabled route fails closed", async () => {
  const kv = new FakeKv({
    [phoneRouteKey("+34910789057")]: JSON.stringify({ schemaVersion: 1, tenantId: "clinica-estetica-madrid", status: "disabled" }),
  });
  assert.equal(await new KvTenantRepository(kv).resolveByCalledNumber("+34910789057"), null);
});

test("F4-KV04 two businesses remain isolated", async () => {
  const kv = new FakeKv({
    [tenantConfigurationKey("clinica-estetica-madrid")]: tenantConfig("clinica-estetica-madrid", "Clínica Estética Madrid", "Carolina"),
    [tenantConfigurationKey("restaurante-centro")]: tenantConfig("restaurante-centro", "Restaurante Centro", "Lucía"),
  });
  const repo = new KvTenantRepository(kv);
  const clinic = await repo.getTenantConfiguration("clinica-estetica-madrid");
  const restaurant = await repo.getTenantConfiguration("restaurante-centro");
  assert.equal(clinic?.business.displayName, "Clínica Estética Madrid");
  assert.equal(clinic?.assistant.name, "Carolina");
  assert.equal(restaurant?.business.displayName, "Restaurante Centro");
  assert.equal(restaurant?.assistant.name, "Lucía");
});

test("F4-KV05 tenant payload cannot impersonate another tenant", () => {
  assert.throws(
    () => parseTenantConfigurationV1(tenantConfig("tenant-b", "B", "Bot B"), "tenant-a"),
    /Tenant configuration mismatch/,
  );
});

test("F4-KV06 malformed or unsupported schema is rejected", () => {
  assert.throws(() => parseTenantConfigurationV1(JSON.stringify({ schemaVersion: 999 }), "tenant-a"), /Unsupported/);
});

test("F4-KV07 duplicate allowed tools are rejected", () => {
  const value = JSON.parse(tenantConfig("tenant-a", "A", "Bot A"));
  value.tools.allowed = ["x", "x"];
  assert.throws(() => parseTenantConfigurationV1(JSON.stringify(value), "tenant-a"), /duplicate/);
});
