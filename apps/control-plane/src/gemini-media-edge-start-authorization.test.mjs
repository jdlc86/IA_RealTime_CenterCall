import test from "node:test";
import assert from "node:assert/strict";
import { requireGeminiMediaEdgeStartAuthorization } from "../.test-dist/gemini-media-edge-start-authorization.js";

function claims(overrides = {}) {
  return {
    credentialId: "cred-1",
    provider: "GEMINI",
    tenantId: "tenant-a",
    callControlId: "call-a",
    edgeUrl: "wss://media.example.test/telnyx/gemini",
    targetLegs: "self",
    notAfterEpochMs: 2_000,
    ...overrides,
  };
}

function start(overrides = {}) {
  return {
    event: "start",
    stream_id: "stream-1",
    start: {
      call_control_id: "call-a",
      call_session_id: "session-1",
      media_format: {
        encoding: "L16",
        sample_rate: 16000,
        channels: 1,
      },
      ...overrides,
    },
  };
}

test("correct credential and Telnyx identity consume once immediately before media acceptance", async () => {
  const calls = [];
  const authorized = await requireGeminiMediaEdgeStartAuthorization(
    {
      rawCredential: "opaque-secret",
      telnyxStartFrame: start(),
      verifyNowEpochMs: 1_500,
      consumeNowEpochMs: 1_600,
    },
    async () => claims(),
    async (credentialId, notAfterEpochMs) => {
      calls.push({ credentialId, notAfterEpochMs });
      return true;
    },
  );

  assert.equal(authorized.credential.binding.callControlId, "call-a");
  assert.equal(authorized.telnyxStart.callControlId, "call-a");
  assert.equal(authorized.telnyxStart.streamId, "stream-1");
  assert.deepEqual(calls, [{ credentialId: "cred-1", notAfterEpochMs: 2_000 }]);
  assert.equal(JSON.stringify(authorized).includes("opaque-secret"), false);
});

test("wrong Telnyx call identity does not burn the valid one-shot credential", async () => {
  let consumeCalls = 0;
  await assert.rejects(
    requireGeminiMediaEdgeStartAuthorization(
      {
        rawCredential: "opaque-secret",
        telnyxStartFrame: start({ call_control_id: "attacker-call" }),
        verifyNowEpochMs: 1_500,
        consumeNowEpochMs: 1_600,
      },
      async () => claims(),
      async () => { consumeCalls += 1; return true; },
    ),
    /does not match the authorized Gemini edge session/,
  );
  assert.equal(consumeCalls, 0);
});

test("wrong media format does not consume the credential", async () => {
  let consumeCalls = 0;
  await assert.rejects(
    requireGeminiMediaEdgeStartAuthorization(
      {
        rawCredential: "opaque-secret",
        telnyxStartFrame: start({ media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 } }),
        verifyNowEpochMs: 1_500,
        consumeNowEpochMs: 1_600,
      },
      async () => claims(),
      async () => { consumeCalls += 1; return true; },
    ),
    /requires mono L16 at 16000 Hz/,
  );
  assert.equal(consumeCalls, 0);
});

test("credential that expires after verification but before start authorization is not consumed", async () => {
  let consumeCalls = 0;
  await assert.rejects(
    requireGeminiMediaEdgeStartAuthorization(
      {
        rawCredential: "opaque-secret",
        telnyxStartFrame: start(),
        verifyNowEpochMs: 1_999,
        consumeNowEpochMs: 2_000,
      },
      async () => claims(),
      async () => { consumeCalls += 1; return true; },
    ),
    /credential expired/,
  );
  assert.equal(consumeCalls, 0);
});

test("atomic replay rejection happens after matching Telnyx identity and before media acceptance", async () => {
  let consumeCalls = 0;
  await assert.rejects(
    requireGeminiMediaEdgeStartAuthorization(
      {
        rawCredential: "opaque-secret",
        telnyxStartFrame: start(),
        verifyNowEpochMs: 1_500,
        consumeNowEpochMs: 1_600,
      },
      async () => claims(),
      async () => { consumeCalls += 1; return false; },
    ),
    /already consumed/,
  );
  assert.equal(consumeCalls, 1);
});
