import test from "node:test";
import assert from "node:assert/strict";
import { recordCallerSecuritySignalDurably } from "../.test-dist/caller-security-signal-delivery.js";

const signal = {
  tenantId: "tenant-test",
  callerPhone: "+34600000000",
  eventType: "PROMPT_EXFILTRATION_HIGH",
  severity: "HIGH",
  riskDelta: 5,
  highConfidence: true,
  metadata: { raw_transcript_stored: false },
};

test("failed direct persistence queues the same idempotency key without phone or transcript", async (t) => {
  let rpcBody;
  let queuedBody;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    rpcBody = JSON.parse(init.body);
    return new Response("unavailable", { status: 503 });
  });
  const host = {
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "test-secret",
      CALLER_SECURITY_SIGNALS: {
        async send(body) { queuedBody = body; return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } }; },
      },
    },
  };

  const result = await recordCallerSecuritySignalDurably(host, signal);
  assert.equal(result.delivery, "QUEUED");
  assert.equal(queuedBody.eventKey, rpcBody.p_event_key);
  assert.equal(queuedBody.callerKey, rpcBody.p_caller_key);
  assert.equal("callerPhone" in queuedBody, false);
  assert.equal(JSON.stringify(queuedBody).includes(signal.callerPhone), false);
});

test("successful direct persistence does not enqueue", async (t) => {
  let queueCalls = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json([{
    action: "ALLOW_FUTURE_CALLS", blocked_until: null, permanent_block: false,
    risk_score: 5, security_strikes: 1, reason: signal.eventType,
  }]));
  const host = {
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "test-secret",
      CALLER_SECURITY_SIGNALS: { async send() { queueCalls += 1; } },
    },
  };

  const result = await recordCallerSecuritySignalDurably(host, signal);
  assert.equal(result.delivery, "DIRECT");
  assert.equal(result.decision.security_strikes, 1);
  assert.equal(queueCalls, 0);
});

test("caller security delivery preserves a source-provided deterministic event key across direct and queue attempts", async (t) => {
  const deterministicEventKey = `gemini-fast-semsec-v1:${"b".repeat(64)}`;
  let rpcEventKey;
  let queuedEventKey;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    rpcEventKey = JSON.parse(init.body).p_event_key;
    return new Response("unavailable", { status: 503 });
  });
  const result = await recordCallerSecuritySignalDurably({
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "test-secret",
      CALLER_SECURITY_SIGNALS: { async send(body) { queuedEventKey = body.eventKey; } },
    },
  }, { ...signal, eventKey: deterministicEventKey });
  assert.equal(result.delivery, "QUEUED");
  assert.equal(rpcEventKey, deterministicEventKey);
  assert.equal(queuedEventKey, deterministicEventKey);
});

test("caller HMAC identity remains isolated by both tenant and trusted caller", async () => {
  const { CallerSecurityService } = await import("../.test-dist/caller-security.js");
  const service = new CallerSecurityService({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "shared-caller-identity-secret",
  });
  const base = await service.callerKey("tenant-a", "+34600000000");
  assert.notEqual(base, await service.callerKey("tenant-b", "+34600000000"));
  assert.notEqual(base, await service.callerKey("tenant-a", "+34600000001"));
});
