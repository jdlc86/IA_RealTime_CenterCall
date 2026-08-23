import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeGeminiMediaEdgeCredentialOnce,
  verifyGeminiMediaEdgeCredential,
} from "../.test-dist/gemini-media-edge-credential-consumption.js";

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

test("verified credential derives its binding from authenticated claims without exposing the raw secret", async () => {
  const authorized = await verifyGeminiMediaEdgeCredential(
    "opaque-secret",
    1_500,
    async () => claims(),
  );

  assert.deepEqual(authorized, { credentialId: "cred-1", binding });
  assert.equal(JSON.stringify(authorized).includes("opaque-secret"), false);
});

test("provider, identity, target legs and secure edge URL fail closed during verification", async () => {
  const cases = [
    [claims({ provider: "OPENAI" }), /provider must be GEMINI/],
    [claims({ tenantId: " " }), /tenant_id is required/],
    [claims({ callControlId: " " }), /call_control_id is required/],
    [claims({ targetLegs: "caller" }), /target legs are invalid/],
    [claims({ edgeUrl: "ws://media.example.test/telnyx/gemini" }), /must use wss:\/\//],
  ];

  for (const [verified, pattern] of cases) {
    await assert.rejects(
      verifyGeminiMediaEdgeCredential("opaque-secret", 1_500, async () => verified),
      pattern,
    );
  }
});

test("credential cannot be embedded in its signed edge URL", async () => {
  await assert.rejects(
    verifyGeminiMediaEdgeCredential(
      "opaque-secret",
      1_500,
      async () => claims({ edgeUrl: "wss://media.example.test/telnyx/gemini?auth=opaque-secret" }),
    ),
    /must not be embedded/,
  );
});

test("expired credential fails during verification", async () => {
  for (const nowEpochMs of [2_000, 2_001]) {
    await assert.rejects(
      verifyGeminiMediaEdgeCredential("opaque-secret", nowEpochMs, async () => claims()),
      /credential expired/,
    );
  }
});

test("verified credential is rechecked for expiry and atomically consumed once", async () => {
  const authorized = await verifyGeminiMediaEdgeCredential("opaque-secret", 1_500, async () => claims());
  const consumed = new Set();
  const calls = [];
  const consumer = async (credentialId, notAfterEpochMs) => {
    calls.push({ credentialId, notAfterEpochMs });
    if (consumed.has(credentialId)) return false;
    consumed.add(credentialId);
    return true;
  };

  assert.equal(await consumeGeminiMediaEdgeCredentialOnce(authorized, 1_900, consumer), authorized);
  assert.deepEqual(calls, [{ credentialId: "cred-1", notAfterEpochMs: 2_000 }]);

  await assert.rejects(
    consumeGeminiMediaEdgeCredentialOnce(authorized, 1_901, consumer),
    /already consumed/,
  );
});

test("credential expiring while waiting for Telnyx start is not consumed", async () => {
  const authorized = await verifyGeminiMediaEdgeCredential("opaque-secret", 1_999, async () => claims());
  let consumeCalls = 0;

  await assert.rejects(
    consumeGeminiMediaEdgeCredentialOnce(
      authorized,
      2_000,
      async () => { consumeCalls += 1; return true; },
    ),
    /credential expired/,
  );
  assert.equal(consumeCalls, 0);
});

test("verifier and consumer errors are redacted and never propagate the raw credential", async () => {
  const rawCredential = "super-secret-token";

  await assert.rejects(
    verifyGeminiMediaEdgeCredential(
      rawCredential,
      1_500,
      async () => { throw new Error(`bad signature for ${rawCredential}`); },
    ),
    (error) => {
      assert.equal(error.message, "Gemini media edge credential verification failed");
      assert.equal(error.message.includes(rawCredential), false);
      return true;
    },
  );

  const authorized = await verifyGeminiMediaEdgeCredential(rawCredential, 1_500, async () => claims());
  await assert.rejects(
    consumeGeminiMediaEdgeCredentialOnce(
      authorized,
      1_600,
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
  const authorized = await verifyGeminiMediaEdgeCredential("opaque-secret", 1_500, async () => claims());
  let consumeCalls = 0;

  await assert.rejects(
    consumeGeminiMediaEdgeCredentialOnce(
      authorized,
      1_999,
      async () => { consumeCalls += 1; return false; },
    ),
    /already consumed/,
  );
  assert.equal(consumeCalls, 1);
});
