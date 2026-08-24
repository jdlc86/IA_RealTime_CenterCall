import assert from "node:assert/strict";
import test from "node:test";
import { CallerSecurityService } from "../.test-dist/caller-security.js";

test("inbound caller security sends the signed Telnyx event id to the idempotent RPC", async (t) => {
  let request = null;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url: String(url), body: JSON.parse(String(init.body)) };
    return Response.json([{
      decision: "ALLOW",
      blocked_until: null,
      permanent_block: false,
      calls_1m: 1,
      calls_5m: 1,
      calls_1h: 1,
      risk_score: 0,
      security_strikes: 0,
      rate_limit_blocks: 0,
      reason: "OK",
    }]);
  });

  const service = new CallerSecurityService({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SECRET_KEY: "test-secret-key",
  });
  const result = await service.evaluateInbound("tenant-a", "+34910000000", "telnyx-event-123");

  assert.equal(result.decision, "ALLOW");
  assert.match(request.url, /\/rpc\/evaluate_inbound_call_security_v2$/);
  assert.equal(request.body.p_tenant_id, "tenant-a");
  assert.equal(request.body.p_event_key, "telnyx-event-123");
  assert.equal(typeof request.body.p_caller_key, "string");
  assert.equal(request.body.p_caller_key.length, 64);
});
