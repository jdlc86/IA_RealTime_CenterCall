import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HumanHandoffTransportAdapter } from "../.test-dist/human-handoff-transport-port.js";

const v37 = readFileSync(new URL("./call-session-v37.ts", import.meta.url), "utf8");

test("V37 delegates physical source-leg transfer through the neutral handoff port", () => {
  assert.match(v37, /humanHandoffTransportPortFor\(this as any\)\.startTransfer\(/);
  assert.match(v37, /physical_transfer_owner:\s*"human_handoff_transport_port"/);
  assert.doesNotMatch(v37, /\bTELNYX_API_KEY\b/);
  assert.doesNotMatch(v37, /api\.telnyx\.com/);
  assert.doesNotMatch(v37, /\bfetch\s*\(/);
});

test("human-handoff transport adapter owns provider credentials, endpoint and transfer wire", async () => {
  const calls = [];
  const session = { env: { TELNYX_API_KEY: "secret" } };
  const adapter = new HumanHandoffTransportAdapter(session, async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 202 });
  });

  const result = await adapter.startTransfer({
    sourceCallControlId: "source/1",
    destinationPhone: "+34910000001",
    originatingNumber: "+34910000002",
    answerTimeoutSeconds: 25,
    commandId: "handoff-1-human-transfer",
    correlationState: "encoded-state",
  });

  assert.deepEqual(result, { started: true, httpStatus: 202 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telnyx.com/v2/calls/source%2F1/actions/transfer");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    to: "+34910000001",
    from: "+34910000002",
    timeout_secs: 25,
    command_id: "handoff-1-human-transfer",
    client_state: "encoded-state",
    target_leg_client_state: "encoded-state",
  });
});

test("human-handoff transport adapter fails closed without provider credentials", async () => {
  let fetchCalled = false;
  const adapter = new HumanHandoffTransportAdapter({}, async () => {
    fetchCalled = true;
    return new Response(null, { status: 202 });
  });

  const result = await adapter.startTransfer({
    sourceCallControlId: "source-1",
    destinationPhone: "+34910000001",
    originatingNumber: "+34910000002",
    answerTimeoutSeconds: 25,
    commandId: "handoff-1-human-transfer",
    correlationState: "encoded-state",
  });

  assert.equal(result.started, false);
  assert.match(result.error ?? "", /TELNYX_API_KEY unavailable/);
  assert.equal(fetchCalled, false);
});
