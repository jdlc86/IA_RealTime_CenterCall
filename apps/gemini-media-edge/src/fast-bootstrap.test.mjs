import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryFastBootstrapRegistry, canonicalFastBootstrap } from "./fast-bootstrap.mjs";

const NOW = Date.now();
const base = Object.freeze({
  credentialId: "cred-fast-1",
  tenantId: "tenant-fast",
  callControlId: "v3:fast-call",
  notAfterEpochMs: NOW + 60_000,
  systemInstruction: "Atiende con respuestas breves y naturales.",
  tools: [{
    name: "restaurant_reservation_create",
    description: "Create or continue a reservation.",
    parameters: { type: "object", properties: {} },
  }],
});

test("fast bootstrap contains only call policy needed by the media runtime", () => {
  const value = canonicalFastBootstrap(base, NOW);
  assert.deepEqual(Object.keys(value).sort(), [
    "callControlId", "credentialId", "languageCode", "notAfterEpochMs", "provider",
    "systemInstruction", "tenantId", "tools", "version", "voiceName",
  ]);
  assert.equal(value.provider, "GEMINI");
  assert.equal(value.voiceName, "Kore");
  assert.equal(value.languageCode, "es-ES");
  assert.equal(JSON.stringify(value).includes("controlCapability"), false);
  assert.equal(JSON.stringify(value).includes("OpenAI"), false);
});

test("fast bootstrap registry is retry-idempotent and one-shot on media consume", () => {
  const registry = new InMemoryFastBootstrapRegistry();
  const first = registry.register(base, NOW);
  const retry = registry.register(base, NOW);
  assert.deepEqual(retry, first);
  const claims = {
    credentialId: base.credentialId,
    tenantId: base.tenantId,
    callControlId: base.callControlId,
    notAfterEpochMs: base.notAfterEpochMs,
  };
  assert.deepEqual(registry.consumeForClaims(claims, NOW), first);
  assert.throws(() => registry.consumeForClaims(claims, NOW), /not registered/);
});

test("fast bootstrap rejects identity rebinding and expiry", () => {
  const registry = new InMemoryFastBootstrapRegistry();
  registry.register(base, NOW);
  assert.throws(() => registry.register({ ...base, tenantId: "other" }, NOW), /different content/);
  assert.throws(() => canonicalFastBootstrap({ ...base, notAfterEpochMs: NOW }, NOW), /expired/);
});
