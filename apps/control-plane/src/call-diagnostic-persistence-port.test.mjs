import test from "node:test";
import assert from "node:assert/strict";
import { callDiagnosticPersistencePortFor } from "../.test-dist/call-diagnostic-persistence-port.js";

test("diagnostic persistence port owns the provider request", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 201 });
  };
  try {
    const host = { env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" } };
    await callDiagnosticPersistencePortFor(host).write({
      call_id: "call-1",
      tenant_id: "restaurante-centro",
      component: "CallSession",
      stage: "STARTED",
      event: "call_diagnostic",
      severity: "info",
    });
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, "/rest/v1/call_diagnostic_events");
    assert.equal(requests[0].init.headers.apikey, "sb_secret_test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
