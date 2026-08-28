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
  assert.equal(captured.url, "https://worker.example/internal/fast-semantic-security-signal");
  assert.equal(captured.init.headers.authorization, "Bearer 0123456789abcdef0123456789abcdef");
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(Object.keys(body).sort(), ["callerPhoneE164", "category", "eventKey", "tenantId"]);
  assert.equal(body.tenantId, input.tenantId);
  assert.equal(body.callerPhoneE164, input.callerPhoneE164);
  assert.equal(body.category, input.category);
  assert.match(body.eventKey, /^gemini-fast-semsec-v1:[a-f0-9]{64}$/);
  assert.equal(captured.init.body.includes(input.callControlId), false);
  assert.equal(captured.init.body.includes(input.toolCallId), false);
  assert.equal(captured.init.body.includes("transcript"), false);
  assert.ok(captured.init.signal instanceof AbortSignal);
});

test("Fast security client derives the same event key for a retry and isolates tenant/call/tool/category", async () => {
  const keys = [];
  const client = createFastSecurityControlClient({
    baseUrl: "https://worker.example",
    controlToken: "0123456789abcdef0123456789abcdef",
    fetcher: async (_input, init) => {
      keys.push(JSON.parse(init.body).eventKey);
      return Response.json({ ok: true, status: "SECURITY_SIGNAL_ACCEPTED" }, { status: 202 });
    },
  });
  const base = { tenantId: "tenant-a", callControlId: "call-a", callerPhoneE164: "+34600000000", toolCallId: "tool-a", category: "PROMPT_INJECTION" };
  await client.recordSemanticIncident(base);
  await client.recordSemanticIncident(base);
  await client.recordSemanticIncident({ ...base, tenantId: "tenant-b" });
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
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

test("Fast security client bounds a hung sideband request", async () => {
  const client = createFastSecurityControlClient({
    baseUrl: "https://worker.example",
    controlToken: "0123456789abcdef0123456789abcdef",
    timeoutMs: 100,
    fetcher: async (_input, init) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("test timeout did not abort")), 500);
      init.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      }, { once: true });
    }),
  });
  const started = Date.now();
  const result = await client.recordSemanticIncident({
    tenantId: "tenant-a", callControlId: "call-a", callerPhoneE164: "+34600000000", toolCallId: "tool-a", category: "PROMPT_INJECTION",
  });
  assert.deepEqual(result, { ok: false, status: "SECURITY_SIGNAL_UNAVAILABLE" });
  assert.ok(Date.now() - started < 1_000);
});
