import assert from "node:assert/strict";
import test from "node:test";
import { createFastTemporalControlClient } from "./fast-temporal-control.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

function successfulPayload() {
  return {
    ok: true,
    status: "AUTHORITATIVE_DATETIME",
    time_authoritative: true,
    authoritative_temporal_context: {
      version: 1,
      source: "WORKER_CLOCK",
      timezone: "Europe/Madrid",
      captured_at_epoch_ms: Date.parse("2026-08-28T07:28:05.000Z"),
      now_iso: "2026-08-28T09:28:05+02:00",
      local_date: "2026-08-28",
      local_time: "09:28:05",
      weekday: "viernes",
    },
    instruction: "Usa exclusivamente este reloj autoritativo del Worker.",
  };
}

test("temporal control queries the authenticated Worker endpoint and returns canonical authority", async () => {
  let observed = null;
  const client = createFastTemporalControlClient({
    baseUrl: "https://worker.example",
    controlToken: TOKEN,
    fetcher: async (url, init) => {
      observed = { url: String(url), init };
      return new Response(JSON.stringify(successfulPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.getAuthoritativeDateTime({ tenantId: "tenant-1", callControlId: "call-1" });
  assert.equal(observed.url, "https://worker.example/internal/authoritative-datetime");
  assert.equal(observed.init.method, "POST");
  assert.equal(observed.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(observed.init.body), { tenantId: "tenant-1", callControlId: "call-1" });
  assert.equal(result.ok, true);
  assert.equal(result.time_authoritative, true);
  assert.equal(result.authoritative_temporal_context.source, "WORKER_CLOCK");
  assert.equal(result.authoritative_temporal_context.now_iso, "2026-08-28T09:28:05+02:00");
});

test("temporal control fails closed instead of exposing a stale or invented clock", async () => {
  for (const fetcher of [
    async () => { throw new Error("network down"); },
    async () => new Response(JSON.stringify({ ok: false, status: "TEMPORAL_AUTHORITY_UNAVAILABLE" }), { status: 503 }),
    async () => new Response(JSON.stringify({ ...successfulPayload(), authoritative_temporal_context: { source: "MODEL_CLOCK" } }), { status: 200 }),
  ]) {
    const client = createFastTemporalControlClient({
      baseUrl: "https://worker.example",
      controlToken: TOKEN,
      fetcher,
    });
    const result = await client.getAuthoritativeDateTime({ tenantId: "tenant-1", callControlId: "call-1" });
    assert.deepEqual(result, {
      ok: false,
      status: "TEMPORAL_AUTHORITY_UNAVAILABLE",
      time_authoritative: false,
      instruction: "No afirmes una fecha u hora actual ni materialices una referencia temporal dependiente de ahora porque el kernel no pudo certificar el reloj. Pide reintentar o explica brevemente la indisponibilidad sin inventar datos temporales.",
    });
  }
});

test("temporal control requires call identity and never falls back to local Media Edge time", async () => {
  let called = false;
  const client = createFastTemporalControlClient({
    baseUrl: "https://worker.example",
    controlToken: TOKEN,
    fetcher: async () => {
      called = true;
      throw new Error("should not be called");
    },
  });
  const result = await client.getAuthoritativeDateTime({ tenantId: "tenant-1" });
  assert.equal(called, false);
  assert.equal(result.status, "TEMPORAL_AUTHORITY_UNAVAILABLE");
  assert.equal(result.time_authoritative, false);
});
