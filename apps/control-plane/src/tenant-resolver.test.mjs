import assert from "node:assert/strict";
import test from "node:test";

import { StaticTenantResolver, parseTenantRoutesJson } from "../.test-dist/tenant-resolver.js";

const KNOWN_NUMBER = "+34910789057";
const TENANT_ID = "clinica-estetica-madrid";

function createResolver() {
  return new StaticTenantResolver([
    { calledNumber: KNOWN_NUMBER, tenantId: TENANT_ID },
  ]);
}

test("F1-T01: known called number resolves to the configured tenant", () => {
  assert.deepEqual(createResolver().resolve({ calledNumber: KNOWN_NUMBER }), {
    tenantId: TENANT_ID,
    calledNumber: KNOWN_NUMBER,
    source: "called_number",
  });
});

test("F1-T02: presentation characters are normalized before resolution", () => {
  assert.deepEqual(createResolver().resolve({ calledNumber: "+34 910 789 057" }), {
    tenantId: TENANT_ID,
    calledNumber: KNOWN_NUMBER,
    source: "called_number",
  });
});

test("F1-T03: unknown called number fails closed and never falls back to another tenant", () => {
  assert.equal(createResolver().resolve({ calledNumber: "+34999999999" }), null);
});

test("F1-T03b: empty or invalid called number fails closed", () => {
  const resolver = createResolver();
  assert.equal(resolver.resolve({ calledNumber: "" }), null);
  assert.equal(resolver.resolve({ calledNumber: "---" }), null);
});

test("F1-T04: duplicate normalized called numbers are rejected as invalid configuration", () => {
  assert.throws(
    () => new StaticTenantResolver([
      { calledNumber: KNOWN_NUMBER, tenantId: TENANT_ID },
      { calledNumber: "+34 910 789 057", tenantId: "otro-tenant" },
    ]),
    /Duplicate tenant route/,
  );
});

test("TENANT_ROUTES_JSON parser maps external configuration into domain routes", () => {
  assert.deepEqual(
    parseTenantRoutesJson(JSON.stringify([{ called_number: KNOWN_NUMBER, tenant_id: TENANT_ID }])),
    [{ calledNumber: KNOWN_NUMBER, tenantId: TENANT_ID }],
  );
});

test("TENANT_ROUTES_JSON parser rejects malformed JSON and missing tenant ids", () => {
  assert.throws(() => parseTenantRoutesJson("not-json"), /valid JSON/);
  assert.throws(
    () => parseTenantRoutesJson(JSON.stringify([{ called_number: KNOWN_NUMBER }])),
    /tenantId must be a non-empty string/,
  );
});
