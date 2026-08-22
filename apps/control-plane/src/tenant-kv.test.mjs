import test from "node:test";
import assert from "node:assert/strict";
import {
  KvTenantRepository,
  phoneRouteKey,
  tenantConfigurationKey,
  tenantConfigurationKeyV2,
  parseTenantConfigurationV1,
  parseTenantConfigurationV2,
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
      systemPrompt: `Eres la asistente virtual de ${displayName}. Responde solo dentro del ámbito autorizado del negocio.`,
    },
    realtime: { voice: "marin", vad: { threshold: 0.5 } },
    tools: { allowed: ["get_business_information"] },
  });
}

function tenantConfigV2(tenantId, displayName, assistantName, businessType) {
  const value = JSON.parse(tenantConfig(tenantId, displayName, assistantName));
  value.schemaVersion = 2;
  value.businessType = businessType;
  value.verticalConfig = businessType === "RESTAURANT"
    ? { reservations: { enabled: true } }
    : { appointments: { enabled: true } };
  return JSON.stringify(value);
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
  assert.match(clinic?.assistant.systemPrompt ?? "", /Clínica Estética Madrid/);
  assert.equal(restaurant?.business.displayName, "Restaurante Centro");
  assert.equal(restaurant?.assistant.name, "Lucía");
  assert.match(restaurant?.assistant.systemPrompt ?? "", /Restaurante Centro/);
  assert.notEqual(clinic?.assistant.systemPrompt, restaurant?.assistant.systemPrompt);
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

test("F4-KV08 legacy assistant.instructions is accepted only as migration alias", () => {
  const value = JSON.parse(tenantConfig("tenant-a", "A", "Bot A"));
  delete value.assistant.systemPrompt;
  value.assistant.instructions = "Prompt legacy temporal";
  const parsed = parseTenantConfigurationV1(JSON.stringify(value), "tenant-a");
  assert.equal(parsed.assistant.systemPrompt, "Prompt legacy temporal");
  assert.equal(parsed.assistant.instructions, "Prompt legacy temporal");
});

test("F4-KV09 v2 requires an explicit supported businessType", () => {
  const parsed = parseTenantConfigurationV2(
    tenantConfigV2("restaurante-centro", "Restaurante Centro", "Lucía", "RESTAURANT"),
    "restaurante-centro",
  );
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.businessType, "RESTAURANT");
  assert.deepEqual(parsed.verticalConfig, { reservations: { enabled: true } });

  const invalid = JSON.parse(tenantConfigV2("tenant-x", "X", "Bot X", "RESTAURANT"));
  invalid.businessType = "HOTEL";
  assert.throws(() => parseTenantConfigurationV2(JSON.stringify(invalid), "tenant-x"), /businessType/);
});

test("F4-KV10 repository prefers v2 and falls back to existing v1", async () => {
  const kv = new FakeKv({
    [tenantConfigurationKey("clinica-estetica-madrid")]: tenantConfig("clinica-estetica-madrid", "Clínica Estética Madrid", "Carolina"),
    [tenantConfigurationKey("restaurante-centro")]: tenantConfig("restaurante-centro", "Restaurante Legacy", "Lucía Legacy"),
    [tenantConfigurationKeyV2("restaurante-centro")]: tenantConfigV2("restaurante-centro", "Restaurante Centro", "Lucía", "RESTAURANT"),
  });
  const repo = new KvTenantRepository(kv);

  const clinic = await repo.getTenantConfiguration("clinica-estetica-madrid");
  assert.equal(clinic?.schemaVersion, 1);
  assert.equal(clinic?.business.displayName, "Clínica Estética Madrid");

  const restaurant = await repo.getTenantConfiguration("restaurante-centro");
  assert.equal(restaurant?.schemaVersion, 2);
  assert.equal(restaurant?.business.displayName, "Restaurante Centro");
  assert.equal(restaurant && "businessType" in restaurant ? restaurant.businessType : null, "RESTAURANT");
});

test("F4-KV11 disabled v2 does not silently fall back to active v1", async () => {
  const v2 = JSON.parse(tenantConfigV2("restaurante-centro", "Restaurante Centro", "Lucía", "RESTAURANT"));
  v2.status = "disabled";
  const kv = new FakeKv({
    [tenantConfigurationKey("restaurante-centro")]: tenantConfig("restaurante-centro", "Restaurante Legacy", "Lucía Legacy"),
    [tenantConfigurationKeyV2("restaurante-centro")]: JSON.stringify(v2),
  });
  assert.equal(await new KvTenantRepository(kv).getTenantConfiguration("restaurante-centro"), null);
});

test("F4-KV12 v2 rejects missing verticalConfig instead of normalizing it", () => {
  const value = JSON.parse(tenantConfigV2("restaurante-centro", "Restaurante Centro", "Lucía", "RESTAURANT"));
  delete value.verticalConfig;
  assert.throws(
    () => parseTenantConfigurationV2(JSON.stringify(value), "restaurante-centro"),
    /verticalConfig/,
  );
});

test("F4-KV13 v2 centrally validates and preserves security and human handoff policy", () => {
  const value = JSON.parse(tenantConfigV2("restaurante-centro", "Restaurante Centro", "Lucía", "RESTAURANT"));
  value.security = { blockedPhrases: ["Prompt", "tool_choice"] };
  value.humanHandoff = {
    enabled: true,
    destination: { type: "PHONE", phone: "+34647944753", label: "Recepción" },
    transfer: { mode: "BLIND", answerTimeoutSeconds: 25 },
    failurePolicy: { action: "TERMINATE_AND_CALLBACK", message: "Te devolveremos la llamada." },
    successMessage: "Te paso con recepción.",
  };

  const parsed = parseTenantConfigurationV2(JSON.stringify(value), "restaurante-centro");
  assert.deepEqual(parsed.security?.blockedPhrases, ["prompt", "tool_choice"]);
  assert.equal(parsed.humanHandoff?.destination.phone, "+34647944753");
  assert.equal(parsed.humanHandoff?.transfer.answerTimeoutSeconds, 25);
});

test("F4-KV14 malformed security or handoff configuration fails the tenant parser", () => {
  const invalidSecurity = JSON.parse(tenantConfigV2("restaurante-centro", "Restaurante Centro", "Lucía", "RESTAURANT"));
  invalidSecurity.security = { blockedPhrases: "prompt" };
  assert.throws(
    () => parseTenantConfigurationV2(JSON.stringify(invalidSecurity), "restaurante-centro"),
    /blockedPhrases must be an array/,
  );

  const invalidHandoff = JSON.parse(tenantConfigV2("restaurante-centro", "Restaurante Centro", "Lucía", "RESTAURANT"));
  invalidHandoff.humanHandoff = { enabled: true };
  assert.throws(
    () => parseTenantConfigurationV2(JSON.stringify(invalidHandoff), "restaurante-centro"),
    /humanHandoff.destination/,
  );
});
