import test from "node:test";
import assert from "node:assert/strict";
import { RestaurantBusinessRuntime } from "../.test-dist/restaurant-business-port.js";

test("restaurant business port exposes facts without leaking the persistence provider", async () => {
  const calls = [];
  const adapter = {
    async listServices(tenantId) { calls.push(["services", tenantId]); return []; },
    async listProfessionals(tenantId) { calls.push(["professionals", tenantId]); return []; },
    async listBusinessHours(tenantId) { calls.push(["hours", tenantId]); return []; },
    async listMenuItems(tenantId) { calls.push(["menu", tenantId]); return []; },
  };
  const runtime = new RestaurantBusinessRuntime({}, adapter);
  await runtime.listServices("restaurante-centro");
  await runtime.listProfessionals("restaurante-centro");
  await runtime.listBusinessHours("restaurante-centro");
  await runtime.listMenuItems("restaurante-centro");
  assert.deepEqual(calls, [
    ["services", "restaurante-centro"],
    ["professionals", "restaurante-centro"],
    ["hours", "restaurante-centro"],
    ["menu", "restaurante-centro"],
  ]);
});
