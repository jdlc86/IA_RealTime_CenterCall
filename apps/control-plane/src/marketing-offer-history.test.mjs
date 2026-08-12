import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseMarketingConsentStore } from "../.test-dist/marketing-consent-store.js";

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "secret" };

test("latest marketing offer is read tenant+phone scoped", async () => {
  await withFetch(async (url, options) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/rest/v1/marketing_consent_offers");
    assert.equal(parsed.searchParams.get("tenant_id"), "eq.restaurante-centro");
    assert.equal(parsed.searchParams.get("phone"), "eq.+34612345678");
    assert.equal(parsed.searchParams.get("order"), "offered_at.desc");
    assert.equal(options.method, "GET");
    return new Response(JSON.stringify([{ offered_at: "2026-08-12T19:00:00Z" }]), { status: 200 });
  }, async () => {
    const result = await new SupabaseMarketingConsentStore(env).getLatestOfferAt("restaurante-centro", "+34612345678");
    assert.equal(result, "2026-08-12T19:00:00Z");
  });
});

test("recordOffer persists only backend audit facts", async () => {
  await withFetch(async (url, options) => {
    assert.match(String(url), /\/rest\/v1\/marketing_consent_offers$/);
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.deepEqual(body, {
      tenant_id: "restaurante-centro",
      phone: "+34612345678",
      call_id: "rtc_offer_1",
      policy_version: "post-booking-offer-v1",
    });
    return new Response("", { status: 201 });
  }, async () => {
    await new SupabaseMarketingConsentStore(env).recordOffer("restaurante-centro", {
      phone: "+34612345678",
      callId: "rtc_offer_1",
      policyVersion: "post-booking-offer-v1",
    });
  });
});

test("offer history read failure fails instead of assuming eligibility", async () => {
  await withFetch(async () => new Response("unavailable", { status: 503 }), async () => {
    await assert.rejects(
      () => new SupabaseMarketingConsentStore(env).getLatestOfferAt("restaurante-centro", "+34612345678"),
      /read failed with HTTP 503/,
    );
  });
});
