import test from "node:test";
import assert from "node:assert/strict";
import { routeFastSemanticSecuritySignal } from "../.test-dist/fast-semantic-security-signal.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const BODY = {
  tenantId: "tenant-test",
  callerPhoneE164: "+34600000000",
  category: "PROMPT_INJECTION",
  eventKey: `gemini-fast-semsec-v1:${"a".repeat(64)}`,
};

function request(body = BODY, token = TOKEN) {
  return new Request("https://worker.example/internal/fast-semantic-security-signal", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function host() {
  return { env: { MEDIA_EDGE_CONTROL_PLANE_TOKEN: TOKEN } };
}

test("authenticated Fast semantic signal delegates bounded deterministic policy to durable caller security", async () => {
  let captured;
  const response = await routeFastSemanticSecuritySignal(request(), host(), {
    async recordSignal(_host, signal) {
      captured = signal;
      return {
        delivery: "DIRECT",
        decision: {
          action: "ALLOW_FUTURE_CALLS",
          blocked_until: null,
          permanent_block: false,
          risk_score: 1,
          security_strikes: 0,
          reason: "GEMINI_SEMANTIC_PROMPT_INJECTION",
        },
      };
    },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, status: "SECURITY_SIGNAL_RECORDED" });
  assert.deepEqual(captured, {
    eventKey: BODY.eventKey,
    tenantId: "tenant-test",
    callerPhone: "+34600000000",
    eventType: "GEMINI_SEMANTIC_PROMPT_INJECTION",
    severity: "MEDIUM",
    riskDelta: 1,
    highConfidence: false,
    metadata: {
      source: "GEMINI_FAST_SEMANTIC_BOUNDARY",
      category: "PROMPT_INJECTION",
      raw_transcript_stored: false,
    },
  });
  assert.equal(Object.hasOwn(captured, "transcript"), false);
  assert.equal(Object.hasOwn(captured.metadata, "transcript"), false);
  assert.equal(Object.hasOwn(captured.metadata, "raw_attack_payload"), false);
});

test("Fast semantic signal returns immediately while durable direct-or-queue delivery runs in waitUntil", async () => {
  const owned = [];
  const never = new Promise(() => {});
  const response = await routeFastSemanticSecuritySignal(request(), host(), {
    recordSignal: async () => never,
    waitUntil: (promise) => owned.push(promise),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, status: "SECURITY_SIGNAL_ACCEPTED" });
  assert.equal(owned.length, 1);
});

test("Fast semantic signal awaits durable delivery if the host rejects waitUntil ownership", async () => {
  const response = await routeFastSemanticSecuritySignal(request(), host(), {
    recordSignal: async () => ({ delivery: "QUEUED", decision: null }),
    waitUntil: () => { throw new Error("context closed"); },
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, status: "SECURITY_SIGNAL_QUEUED" });
});

test("Fast semantic signal rejects unauthorized, unknown-category, extra-field and malformed event keys", async () => {
  let called = false;
  const dependencies = { recordSignal: async () => { called = true; throw new Error("must not run"); } };
  assert.equal((await routeFastSemanticSecuritySignal(request(BODY, "wrong"), host(), dependencies)).status, 401);
  assert.equal((await routeFastSemanticSecuritySignal(request({ ...BODY, category: "UNKNOWN" }), host(), dependencies)).status, 400);
  assert.equal((await routeFastSemanticSecuritySignal(request({ ...BODY, transcript: "never" }), host(), dependencies)).status, 400);
  assert.equal((await routeFastSemanticSecuritySignal(request({ ...BODY, eventKey: "random" }), host(), dependencies)).status, 400);
  assert.equal(called, false);
});
