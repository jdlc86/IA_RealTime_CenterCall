import test from "node:test";
import assert from "node:assert/strict";
import {
  createHmacCredentialVerifier,
  InMemoryOneShotCredentialConsumer,
  requireTelnyxStartForCredential,
  signHmacCredentialForTest,
} from "./credential.mjs";

const secret = "x".repeat(32);
const edgeUrl = "wss://edge.example.test/media";
const claims = Object.freeze({
  credentialId: "cred-1",
  provider: "GEMINI",
  tenantId: "tenant-1",
  callControlId: "call-123",
  sessionId: "cs_123",
  routeId: "default",
  callerPhoneE164: "+34647944762",
  calledPhoneE164: "+34910000001",
  securityVersion: 1,
  edgeUrl,
  targetLegs: "self",
  notAfterEpochMs: 2_000_000_000_000,
});

test("signed credential verifies exact immutable call and security binding", async () => {
  const token = signHmacCredentialForTest(claims, secret);
  const verify = createHmacCredentialVerifier(secret, edgeUrl);
  const verified = await verify(token, 1_900_000_000_000);
  assert.equal(verified.credentialId, "cred-1");
  assert.equal(verified.callControlId, "call-123");
  assert.equal(verified.sessionId, "cs_123");
  assert.equal(verified.routeId, "default");
  assert.equal(verified.callerPhoneE164, "+34647944762");
  assert.equal(verified.calledPhoneE164, "+34910000001");
  assert.equal(verified.edgeUrl, edgeUrl);
});

test("signed credential rejects tampering, expiry and wrong edge", async () => {
  const token = signHmacCredentialForTest(claims, secret);
  const verify = createHmacCredentialVerifier(secret, edgeUrl);
  const parts = token.split(".");
  const replacement = parts[2].endsWith("A") ? "B" : "A";
  const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${replacement}`;
  await assert.rejects(() => verify(tampered, 1_900_000_000_000), /verification failed/);
  await assert.rejects(() => verify(token, claims.notAfterEpochMs), /expired/);
  const wrongEdge = createHmacCredentialVerifier(secret, "wss://other.example.test/media");
  await assert.rejects(() => wrongEdge(token, 1_900_000_000_000), /different edge URL/);
});

test("one-shot consumer accepts exactly once and prunes expired ids", () => {
  const consumer = new InMemoryOneShotCredentialConsumer();
  assert.equal(consumer.consume("cred-1", 2_000, 1_000), true);
  assert.equal(consumer.consume("cred-1", 2_000, 1_001), false);
  assert.equal(consumer.consume("cred-2", 3_000, 2_001), true);
  assert.equal(consumer.size(), 1);
});

test("Telnyx start identity is validated before credential consumption", () => {
  const start = {
    event: "start",
    stream_id: "stream-1",
    start: {
      call_control_id: "call-123",
      media_format: { encoding: "L16", sample_rate: 16000, channels: 1 },
    },
  };
  assert.equal(requireTelnyxStartForCredential(claims, start).streamId, "stream-1");
  assert.throws(
    () => requireTelnyxStartForCredential(claims, { ...start, start: { ...start.start, call_control_id: "wrong-call" } }),
    /does not match/,
  );
});
