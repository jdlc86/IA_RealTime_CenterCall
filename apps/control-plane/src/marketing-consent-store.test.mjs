import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseMarketingConsentStore } from "../.test-dist/marketing-consent-store.js";

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "secret" };

test("latest VERIFIED consent is read before prompting again", async () => {
  await withFetch(async (url, options) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/rest/v1/marketing_consents");
    assert.equal(parsed.searchParams.get("select"), "status");
    assert.equal(parsed.searchParams.get("tenant_id"), "eq.restaurante-centro");
    assert.equal(parsed.searchParams.get("phone"), "eq.+34612345678");
    assert.equal(parsed.searchParams.get("order"), "created_at.desc");
    assert.equal(parsed.searchParams.get("limit"), "1");
    assert.equal(options.method, "GET");
    return new Response(JSON.stringify([{ status: "VERIFIED" }]), { status: 200 });
  }, async () => {
    const result = await new SupabaseMarketingConsentStore(env).getLatestStatus("restaurante-centro", "+34612345678");
    assert.equal(result, "VERIFIED");
  });
});

test("no marketing history returns null", async () => {
  await withFetch(async () => new Response("[]", { status: 200 }), async () => {
    const result = await new SupabaseMarketingConsentStore(env).getLatestStatus("restaurante-centro", "+34612345678");
    assert.equal(result, null);
  });
});

test("invalid latest marketing state fails closed", async () => {
  await withFetch(async () => new Response(JSON.stringify([{ status: "UNKNOWN" }]), { status: 200 }), async () => {
    await assert.rejects(
      () => new SupabaseMarketingConsentStore(env).getLatestStatus("restaurante-centro", "+34612345678"),
      /invalid status/,
    );
  });
});

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
