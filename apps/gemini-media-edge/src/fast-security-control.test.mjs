import test from "node:test";
import assert from "node:assert/strict";
import { createFastSecurityControlClient } from "./fast-security-control.mjs";

test("Fast security client posts only the bounded semantic incident over authenticated sideband", async () => {
  let captured = null;
  const client = createFastSecurityControlClient({
    baseUrl: "https://worker.example",
    controlToken: "0123456789abcdef0123456789abcdef",
    fetcher: async (input, init) => {
      captured = { url: String(input), init };
      return new Response(JSON.stringify({ ok: true, status: "SECURITY_SIGNAL_RECORDED" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const input = {
    tenantId: "tenant-test",
    callControlId: "opaque-call",
    callerPhoneE164: "+34600000000",
    toolCallId: "tool-1",
    category: "PROMPT_EXFILTRATION",
  };
  const result = await client.recordSemanticIncident(input);
  assert.equal(result.ok, true);
  assert.equal(result.status, "SECURITY_SIGNAL_RECORDED");
  assert.equal(captured.url, "https://worker.example/internal/security-signal");
  assert.equal(captured.init.headers.authorization, "Bearer 0123456789abcdef0123456789abcdef");
  assert.deepEqual(JSON.parse(captured.init.body), input);
  assert.equal(captured.init.body.includes("transcript"), false);
});

test("Fast security client degrades without throwing when persistence sideband is unavailable", async () => {
  const client = createFastSecurityControlClient({
    baseUrl: "https://worker.example",
    controlToken: "0123456789abcdef0123456789abcdef",
    fetcher: async () => { throw new Error("network unavailable"); },
  });
  const result = await client.recordSemanticIncident({});
  assert.deepEqual(result, { ok: false, status: "SECURITY_SIGNAL_UNAVAILABLE" });
});
