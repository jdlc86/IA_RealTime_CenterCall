import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RestaurantReservationRuntime } from "../.test-dist/restaurant-reservation-port.js";

function runtimeWithRecorder() {
  const calls = [];
  const adapter = {
    async listBookedReservationsByPhone(tenantId, callerPhone) {
      calls.push({ operation: "list", tenantId, callerPhone });
      return [];
    },
    async invokeRpc(name, body) {
      calls.push({ operation: "rpc", name, body });
      return [];
    },
  };
  return { runtime: new RestaurantReservationRuntime({}, adapter), calls };
}

test("restaurant reservation port owns backend RPC names and payload mapping", async () => {
  const { runtime, calls } = runtimeWithRecorder();

  await runtime.checkTablePlan({
    tenantId: "restaurante-centro",
    startsAt: "2026-08-21T20:00:00+02:00",
    partySize: 6,
    durationMinutes: 90,
    excludeReservationId: "reservation-1",
  });
  await runtime.createMultiTableReservation({
    tenantId: "restaurante-centro",
    customerName: "Ana",
    customerPhone: "+34612345678",
    partySize: 6,
    startsAt: "2026-08-21T20:00:00+02:00",
    durationMinutes: 90,
    notes: "ventana",
    source: "voice",
  });
  await runtime.modifyReservation({
    tenantId: "restaurante-centro",
    reservationId: "reservation-1",
    callerPhone: "+34612345678",
    partySize: 4,
    startsAt: "2026-08-22T21:00:00+02:00",
    durationMinutes: 120,
    customerName: "Ana Pérez",
    notes: null,
  });
  await runtime.listBookedReservationsByPhone("restaurante-centro", "+34612345678");

  assert.deepEqual(calls, [
    {
      operation: "rpc",
      name: "check_restaurant_table_plan",
      body: {
        p_tenant_id: "restaurante-centro",
        p_starts_at: "2026-08-21T20:00:00+02:00",
        p_party_size: 6,
        p_duration_minutes: 90,
        p_exclude_reservation_id: "reservation-1",
      },
    },
    {
      operation: "rpc",
      name: "create_restaurant_reservation_multi",
      body: {
        p_tenant_id: "restaurante-centro",
        p_customer_name: "Ana",
        p_customer_phone: "+34612345678",
        p_party_size: 6,
        p_starts_at: "2026-08-21T20:00:00+02:00",
        p_duration_minutes: 90,
        p_notes: "ventana",
        p_source: "voice",
      },
    },
    {
      operation: "rpc",
      name: "modify_restaurant_reservation",
      body: {
        p_tenant_id: "restaurante-centro",
        p_reservation_id: "reservation-1",
        p_caller_phone: "+34612345678",
        p_party_size: 4,
        p_starts_at: "2026-08-22T21:00:00+02:00",
        p_duration_minutes: 120,
        p_customer_name: "Ana Pérez",
        p_notes: null,
      },
    },
    {
      operation: "list",
      tenantId: "restaurante-centro",
      callerPhone: "+34612345678",
    },
  ]);
});

test("V16 delegates reservation persistence without owning provider RPC wire", () => {
  const v16 = readFileSync(new URL("./call-session-v16.ts", import.meta.url), "utf8");

  assert.match(v16, /restaurantReservationPortFor/);
  assert.match(v16, /\.checkTablePlan\(\{/);
  assert.match(v16, /\.createMultiTableReservation\(\{/);
  assert.match(v16, /\.listBookedReservationsByPhone\(/);
  assert.match(v16, /\.modifyReservation\(\{/);

  assert.doesNotMatch(v16, /\bSupabaseAdapter\b/);
  assert.doesNotMatch(v16, /\brpcV16\b/);
  assert.doesNotMatch(v16, /\/rest\/v1\/rpc\//);
  assert.doesNotMatch(v16, /check_restaurant_table_plan/);
  assert.doesNotMatch(v16, /create_restaurant_reservation_multi/);
  assert.doesNotMatch(v16, /modify_restaurant_reservation/);
  assert.doesNotMatch(v16, /\bfetch\s*\(/);
});

test("V11 delegates reservation queries without knowing the persistence provider", () => {
  const v11 = readFileSync(new URL("./call-session-v11.ts", import.meta.url), "utf8");

  assert.match(v11, /restaurantReservationPortFor\(this as any\)\.listBookedReservationsByPhone\(tenantId, callerPhone\)/);
  assert.doesNotMatch(v11, /\bSupabaseAdapter\b/);
  assert.doesNotMatch(v11, /\bSUPABASE_URL\b/);
  assert.doesNotMatch(v11, /\bSUPABASE_SECRET_KEY\b/);
  assert.doesNotMatch(v11, /\/rest\/v1\//);
});
