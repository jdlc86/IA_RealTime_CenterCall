import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseAdapter } from "../.test-dist/supabase-adapter.js";

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "secret" };

test("availability RPC imposes tenant_id server-side", async () => {
  await withFetch(async (url, options) => {
    assert.match(String(url), /\/rest\/v1\/rpc\/check_restaurant_availability$/);
    const body = JSON.parse(options.body);
    assert.equal(body.p_tenant_id, "restaurante-centro");
    assert.equal(body.p_party_size, 4);
    assert.equal(body.p_duration_minutes, 90);
    return new Response(JSON.stringify([{ table_id: "t1", table_code: "T1", table_name: "Mesa 1", max_capacity: 4, starts_at: "2026-08-15T18:00:00.000Z", ends_at: "2026-08-15T19:30:00.000Z" }]), { status: 200 });
  }, async () => {
    const result = await new SupabaseAdapter(env).checkRestaurantAvailability("restaurante-centro", "2026-08-15T20:00:00+02:00", 4);
    assert.equal(result.length, 1);
    assert.equal(result[0].table_code, "T1");
  });
});

test("reservation creation validates E.164 before any backend write", async () => {
  let called = false;
  await withFetch(async () => { called = true; return new Response("[]", { status: 200 }); }, async () => {
    await assert.rejects(
      () => new SupabaseAdapter(env).createRestaurantReservation("restaurante-centro", {
        customerName: "Ana",
        customerPhone: "612345678",
        partySize: 2,
        startsAt: "2026-08-15T20:00:00+02:00",
      }),
      /Invalid phone number/,
    );
  });
  assert.equal(called, false);
});

test("reservation RPC keeps tenant_id and source under backend control", async () => {
  await withFetch(async (url, options) => {
    assert.match(String(url), /\/rest\/v1\/rpc\/create_restaurant_reservation$/);
    const body = JSON.parse(options.body);
    assert.equal(body.p_tenant_id, "restaurante-centro");
    assert.equal(body.p_customer_phone, "+34612345678");
    assert.equal(body.p_source, "voice");
    return new Response(JSON.stringify([{ reservation_id: "r1", table_id: "t1", table_code: "T1", table_name: "Mesa 1", starts_at: "2026-08-15T18:00:00.000Z", ends_at: "2026-08-15T19:30:00.000Z", status: "BOOKED" }]), { status: 200 });
  }, async () => {
    const result = await new SupabaseAdapter(env).createRestaurantReservation("restaurante-centro", {
      customerName: "Ana",
      customerPhone: "+34612345678",
      partySize: 2,
      startsAt: "2026-08-15T20:00:00+02:00",
    });
    assert.equal(result.status, "BOOKED");
  });
});

test("declining marketing is persisted independently from reservation", async () => {
  await withFetch(async (url, options) => {
    assert.match(String(url), /\/rest\/v1\/marketing_consents$/);
    const body = JSON.parse(options.body);
    assert.equal(body.status, "DECLINED");
    assert.equal(body.consented_at, null);
    return new Response(JSON.stringify([{ id: "c1", status: "DECLINED" }]), { status: 201 });
  }, async () => {
    const result = await new SupabaseAdapter(env).createMarketingConsent("restaurante-centro", "+34612345678", false, "restaurant-marketing-v1");
    assert.equal(result.status, "DECLINED");
  });
});
