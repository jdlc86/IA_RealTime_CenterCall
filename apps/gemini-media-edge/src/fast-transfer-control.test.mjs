import assert from "node:assert/strict";
import test from "node:test";
import { createFastTransferControlClient } from "./fast-transfer-control.mjs";

test("fast transfer control client posts authorize and start with shared bearer token", async () => {
  const requests = [];
  const client = createFastTransferControlClient({
    baseUrl: "https://control.example.test/some/path",
    controlToken: "0123456789abcdef0123456789abcdef",
    fetcher: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/authorize")) {
        return new Response(JSON.stringify({
          ok: true,
          status: "HUMAN_HANDOFF_ACCEPTED",
          handoffId: "handoff-test",
          successMessage: "Un momento, por favor.",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, status: "DIALING", handoffId: "handoff-test" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const authorizeBody = {
    tenantId: "tenant-fast",
    callControlId: "v3:call",
    calledPhoneE164: "+34910000001",
    callerPhoneE164: "+34647944762",
    reason: "caller_requested_human",
    contextSummary: "Caller requested reception.",
  };
  const authorized = await client.authorizeTransfer(authorizeBody);
  assert.equal(authorized.ok, true);
  assert.equal(authorized.status, "HUMAN_HANDOFF_ACCEPTED");
  assert.equal(authorized.handoffId, "handoff-test");
  assert.equal(authorized.httpStatus, 200);

  const started = await client.startTransfer({
    tenantId: "tenant-fast",
    callControlId: "v3:call",
    calledPhoneE164: "+34910000001",
    callerPhoneE164: "+34647944762",
    handoffId: "handoff-test",
    reason: "caller_requested_human",
    contextSummary: "Caller requested reception.",
  });
  assert.equal(started.ok, true);
  assert.equal(started.status, "DIALING");
  assert.equal(started.httpStatus, 202);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://control.example.test/internal/call-transfer/authorize");
  assert.equal(requests[1].url, "https://control.example.test/internal/call-transfer/start");
  assert.equal(requests[0].init.headers.authorization, "Bearer 0123456789abcdef0123456789abcdef");
  assert.deepEqual(JSON.parse(requests[0].init.body), authorizeBody);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    tenantId: "tenant-fast",
    callControlId: "v3:call",
    calledPhoneE164: "+34910000001",
    callerPhoneE164: "+34647944762",
    handoffId: "handoff-test",
    reason: "caller_requested_human",
    contextSummary: "Caller requested reception.",
  });
});

test("fast transfer authorization network failure returns fail-closed result instead of throwing", async () => {
  const client = createFastTransferControlClient({
    baseUrl: "https://control.example.test",
    controlToken: "0123456789abcdef0123456789abcdef",
    fetcher: async () => { throw new Error("network down"); },
  });
  const result = await client.authorizeTransfer({ tenantId: "tenant-fast" });
  assert.deepEqual(result, { ok: false, status: "HUMAN_HANDOFF_NOT_AVAILABLE" });
});
