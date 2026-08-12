import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseMarketingConsentStore } from "../.test-dist/marketing-consent-store.js";

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "secret" };

test("grant persists VERIFIED with caller match evidence", async () => {
  await withFetch(async (url, options) => {
    assert.match(String(url), /\/rest\/v1\/marketing_consents$/);
    const body = JSON.parse(options.body);
    assert.equal(body.status, "VERIFIED");
    assert.equal(body.verification_method, "CALLER_ID_MATCH");
    assert.equal(body.phone, "+34612345678");
    assert.equal(body.caller_phone, "+34612345678");
    assert.equal(body.call_id, "rtc_test");
    assert.equal(body.channel, "phone");
    assert.ok(body.consented_at);
    assert.ok(body.verified_at);
    assert.equal(body.revoked_at, null);
    return new Response(JSON.stringify([{ id: "c1", status: "VERIFIED" }]), { status: 201 });
  }, async () => {
    const result = await new SupabaseMarketingConsentStore(env).record("restaurante-centro", {
      action: "GRANT",
      phone: "+34612345678",
      callerPhone: "+34612345678",
      callId: "rtc_test",
      consentTextVersion: "voice-marketing-v2",
      verificationMethod: "CALLER_ID_MATCH",
    });
    assert.equal(result.status, "VERIFIED");
  });
});

test("revoke persists a separate REVOKED audit event", async () => {
  await withFetch(async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.status, "REVOKED");
    assert.equal(body.consented_at, null);
    assert.equal(body.verified_at, null);
    assert.ok(body.revoked_at);
    return new Response(JSON.stringify([{ id: "c2", status: "REVOKED" }]), { status: 201 });
  }, async () => {
    const result = await new SupabaseMarketingConsentStore(env).record("restaurante-centro", {
      action: "REVOKE",
      phone: "+34612345678",
      callerPhone: "+34612345678",
      callId: "rtc_test2",
      consentTextVersion: "voice-marketing-v2",
      verificationMethod: "CALLER_ID_MATCH",
    });
    assert.equal(result.status, "REVOKED");
  });
});

test("store independently rejects mismatched caller and marketing phone", async () => {
  let called = false;
  await withFetch(async () => { called = true; return new Response("[]", { status: 201 }); }, async () => {
    await assert.rejects(() => new SupabaseMarketingConsentStore(env).record("restaurante-centro", {
      action: "GRANT",
      phone: "+34622222222",
      callerPhone: "+34611111111",
      callId: "rtc_test3",
      consentTextVersion: "voice-marketing-v2",
      verificationMethod: "CALLER_ID_MATCH",
    }), /requires caller phone to equal marketing phone/);
  });
  assert.equal(called, false);
});
