import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryFastBootstrapRegistry, canonicalFastBootstrap } from "./fast-bootstrap.mjs";

const NOW = Date.now();
const securityContext = Object.freeze({
  securityVersion: 1,
  sessionId: "cs_fast-call",
  tenantId: "tenant-fast",
  routeId: "default",
  callControlId: "v3:fast-call",
  callerPhoneE164: "+34647944762",
  calledPhoneE164: "+34910000001",
  provider: "TELNYX",
  createdAtEpochMs: NOW,
  notAfterEpochMs: NOW + 60_000,
});
const base = Object.freeze({
  version: "gemini-fast-bootstrap.v2",
  credentialId: "cred-fast-1",
  tenantId: "tenant-fast",
  callControlId: "v3:fast-call",
  notAfterEpochMs: NOW + 60_000,
  securityContext,
  systemInstruction: "Atiende con respuestas breves y naturales.",
  tools: [{
    name: "restaurant_reservation_create",
    capability: "reservation.create",
    description: "Create or continue a reservation.",
    parameters: { type: "object", properties: {} },
  }],
});

function claims() {
  return {
    credentialId: base.credentialId,
    tenantId: base.tenantId,
    callControlId: base.callControlId,
    sessionId: securityContext.sessionId,
    routeId: securityContext.routeId,
    callerPhoneE164: securityContext.callerPhoneE164,
    calledPhoneE164: securityContext.calledPhoneE164,
    securityVersion: securityContext.securityVersion,
    notAfterEpochMs: base.notAfterEpochMs,
  };
}

test("fast bootstrap contains immutable security context needed by the media runtime", () => {
  const value = canonicalFastBootstrap(base, NOW);
  assert.deepEqual(Object.keys(value).sort(), [
    "callControlId", "credentialId", "languageCode", "notAfterEpochMs", "provider", "securityContext",
    "systemInstruction", "tenantId", "tools", "version", "voiceName",
  ]);
  assert.equal(value.provider, "GEMINI");
  assert.equal(value.securityContext.sessionId, "cs_fast-call");
  assert.equal(value.securityContext.routeId, "default");
  assert.equal(value.securityContext.callerPhoneE164, "+34647944762");
  assert.equal(value.securityContext.calledPhoneE164, "+34910000001");
  assert.equal(value.voiceName, "Kore");
  assert.equal(value.languageCode, "es-ES");
  assert.equal(JSON.stringify(value).includes("controlCapability"), false);
});

test("fast bootstrap registry is retry-idempotent and one-shot on media consume", () => {
  const registry = new InMemoryFastBootstrapRegistry();
  const first = registry.register(base, NOW);
  const retry = registry.register(base, NOW);
  assert.deepEqual(retry, first);
  const boundClaims = claims();
  assert.deepEqual(registry.consumeForClaims(boundClaims, NOW), first);
  assert.throws(() => registry.consumeForClaims(boundClaims, NOW), /not registered/);
});

test("fast bootstrap rejects identity rebinding, security mismatch and expiry", () => {
  const registry = new InMemoryFastBootstrapRegistry();
  registry.register(base, NOW);
  assert.throws(() => registry.register({ ...base, tenantId: "other" }, NOW), /different content|identity mismatch/);
  assert.throws(() => registry.consumeForClaims({ ...claims(), tenantId: "tenant-other" }, NOW), /identity mismatch/);
  assert.throws(() => registry.consumeForClaims({ ...claims(), routeId: "sales" }, NOW), /identity mismatch/);
  assert.throws(() => canonicalFastBootstrap({ ...base, notAfterEpochMs: NOW }, NOW), /expired/);
});

test("fast bootstrap requires explicit bounded capability grants on every declared tool", () => {
  assert.throws(() => canonicalFastBootstrap({
    ...base,
    tools: [{ name: "restaurant_reservation_create", description: "Create.", parameters: { type: "object" } }],
  }, NOW), /capability is required/);
  assert.throws(() => canonicalFastBootstrap({ ...base, version: "gemini-fast-bootstrap.v1" }, NOW), /version is invalid/);
});
