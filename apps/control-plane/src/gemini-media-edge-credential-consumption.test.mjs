import test from "node:test";
import assert from "node:assert/strict";
import { requireGeminiMediaEdgeCredentialOnce } from "../.test-dist/gemini-media-edge-credential-consumption.js";

const binding = Object.freeze({
  provider: "GEMINI",
  tenantId: "tenant-a",
  callControlId: "call-a",
  edgeUrl: "wss://media.example.test/telnyx/gemini",
  targetLegs: "self",
  notAfterEpochMs: 2_000,
});

function claims(overrides = {}) {
  return Object.freeze({
    credentialId: "cred-1",
    ...binding,
    ...overrides,
  });
}

test("valid Gemini media edge credential is verified, bound and atomically consumed once", async () => {
  const consumed = new Set();
  const consumeCalls = [];
  const verifier = async () => claims();
  const consumer = async (credentialId, notAfterEpochMs) => {
    consumeCalls.push({ credentialId, notAfterEpochMs });
    if (consumed.has(credentialId)) return false;
    consumed.add(credentialId);
    return true;
  };

  const authorized = await requireGeminiMediaEdgeCredentialOnce(
    "opaque-secret",
    { binding, nowEpochMs: 1_500 },
    verifier,
    consumer,
  );

  assert.deepEqual(authorized, { credentialId: "cred-1", binding });
  assert.deepEqual(consumeCalls, [{ credentialId: "cred-1", notAfterEpochMs: 2_000 }]);
  assert.equal(JSON.stringify(authorized).includes("opaque-secret"), false);

  await assert.rejects(
    requireGeminiMediaEdgeCredentialOnce(
      "opaque-secret",
      { binding, nowEpochMs: 1_501 },
      verifier,
      consumer,
    ),
    /already consumed/,
  );
});

test("binding mismatch fails before replay state is mutated", async () => {
  let consumeCalls = 0;
  await assert.rejects(
    requireGeminiMediaEdgeCredentialOnce(
      "opaque-secret",
      { binding, nowEpochMs: 1_500 },
      async () => claims({ callControlId: "other-call" }),
      async () => { consumeCalls += 1; return true; },
    ),
    /binding mismatch/,
  );
  assert.equal(consumeCalls, 0);
});

test("tenant, provider and media-edge binding are exact", async () => {
  for (const override of [
    { tenantId: "tenant-b" },
    { provider: "OPENAI" },
    { edgeUrl: "wss://other.example.test/telnyx/gemini" },
    { targetLegs: "both" },
    { notAfterEpochMs: 2_001 },
  ]) {
    let consumed = false;
    await assert.rejects(
      requireGeminiMediaEdgeCredentialOnce(
        "opaque-secret",
        { binding, nowEpochMs: 1_500 },
        async () => claims(override),
        async () => { consumed = true; return true; },
      ),
      /binding mismatch/,
    );
    assert.equal(consumed, false);
  }
});

test("expired credential fails before consume and expiry boundary is exclusive", async () => {
  for (const nowEpochMs of [2_000, 2_001]) {
    let consumeCalls = 0;
    await assert.rejects(
      requireGeminiMediaEdgeCredentialOnce(
        "opaque-secret",
        { binding, nowEpochMs },
        async () => claims(),
        async () => { consumeCalls += 1; return true; },
      ),
      /credential expired/,
    );
    assert.equal(consumeCalls, 0);
  }
});

test("verifier and consumer errors are redacted and never propagate the raw credential", async () => {
  const rawCredential = "super-secret-token";

  await assert.rejects(
    requireGeminiMediaEdgeCredentialOnce(
      rawCredential,
      { binding, nowEpochMs: 1_500 },
      async () => { throw new Error(`bad signature for ${rawCredential}`); },
      async () => true,
    ),
    (error) => {
      assert.equal(error.message, "Gemini media edge credential verification failed");
      assert.equal(error.message.includes(rawCredential), false);
      return true;
    },
  );

  await assert.rejects(
    requireGeminiMediaEdgeCredentialOnce(
      rawCredential,
      { binding, nowEpochMs: 1_500 },
      async () => claims(),
      async () => { throw new Error(`storage failure ${rawCredential}`); },
    ),
    (error) => {
      assert.equal(error.message, "Gemini media edge credential consumption failed");
      assert.equal(error.message.includes(rawCredential), false);
      return true;
    },
  );
});

test("atomic consumer false is authoritative replay rejection", async () => {
  let consumeCalls = 0;
  await assert.rejects(
    requireGeminiMediaEdgeCredentialOnce(
      "opaque-secret",
      { binding, nowEpochMs: 1_999 },
      async () => claims(),
      async () => { consumeCalls += 1; return false; },
    ),
    /already consumed/,
  );
  assert.equal(consumeCalls, 1);
});
