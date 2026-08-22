import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HumanHandoffSourceLegRuntime } from "../.test-dist/human-handoff-source-leg-port.js";

function host(env = {}) {
  return { env };
}

function response(status, body = "") {
  return new Response(status === 204 ? null : body, { status });
}

test("source-leg terminal speech is delegated through the provider boundary", async () => {
  const calls = [];
  const runtime = new HumanHandoffSourceLegRuntime(
    host({ TELNYX_API_KEY: "tel-key" }),
    async (url, init) => {
      calls.push({ url: String(url), init });
      return response(200);
    },
  );

  const result = await runtime.speakTerminal({
    sourceCallControlId: "source-1",
    text: "No hemos podido completar la transferencia.",
    clientState: "state-1",
    commandId: "cmd-1",
  });

  assert.deepEqual(result, { ok: true, httpStatus: 200, alreadyEnded: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.telnyx\.com\/v2\/calls\/source-1\/actions\/speak/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.payload, "No hemos podido completar la transferencia.");
  assert.equal(body.client_state, "state-1");
  assert.equal(body.command_id, "cmd-1");
  assert.equal(body.target_legs, "self");
});

test("source-leg fetch is invoked without the runtime as receiver for speech and hangup", async () => {
  const calls = [];
  const receiverSensitiveFetch = async function (url, init) {
    assert.equal(this, undefined, "source-leg fetch must be called as a bare dependency");
    calls.push({ url: String(url), init });
    return response(200);
  };
  const runtime = new HumanHandoffSourceLegRuntime(
    host({ TELNYX_API_KEY: "tel-key" }),
    receiverSensitiveFetch,
  );

  const speech = await runtime.speakTerminal({
    sourceCallControlId: "source-1",
    text: "No hemos podido completar la transferencia.",
    clientState: "state-1",
    commandId: "cmd-speak",
  });
  const hangup = await runtime.hangup({ sourceCallControlId: "source-1", commandId: "cmd-hangup" });

  assert.equal(speech.ok, true);
  assert.equal(hangup.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/actions\/speak$/);
  assert.match(calls[1].url, /\/actions\/hangup$/);
});

test("Telnyx 90018 is normalized as source leg already ended", async () => {
  const runtime = new HumanHandoffSourceLegRuntime(
    host({ TELNYX_API_KEY: "tel-key" }),
    async () => response(422, JSON.stringify({ errors: [{ code: "90018" }] })),
  );

  const result = await runtime.speakTerminal({
    sourceCallControlId: "source-2",
    text: "mensaje",
    clientState: "state-2",
    commandId: "cmd-2",
  });

  assert.equal(result.ok, false);
  assert.equal(result.alreadyEnded, true);
  assert.equal(result.httpStatus, 422);
});

test("source-leg hangup treats 422 as already terminal without inventing success", async () => {
  const runtime = new HumanHandoffSourceLegRuntime(
    host({ TELNYX_API_KEY: "tel-key" }),
    async () => response(422, "already ended"),
  );

  const result = await runtime.hangup({ sourceCallControlId: "source-3", commandId: "cmd-3" });
  assert.deepEqual(result, { ok: false, httpStatus: 422, alreadyEnded: true });
});

test("V38 owns policy but contains no direct Telnyx transport calls", () => {
  const v38 = readFileSync(new URL("./call-session-v38.ts", import.meta.url), "utf8");
  assert.match(v38, /humanHandoffSourceLegPortFor/);
  assert.match(v38, /\.speakTerminal\(\{/);
  assert.match(v38, /\.hangup\(\{/);
  assert.doesNotMatch(v38, /api\.telnyx\.com/);
  assert.doesNotMatch(v38, /TELNYX_API_KEY/);
  assert.doesNotMatch(v38, /\/actions\/speak/);
  assert.doesNotMatch(v38, /\/actions\/hangup/);
  assert.match(v38, /TERMINAL_SPEECH_WATCHDOG_MS = 15_000/);
  assert.match(v38, /classifyHandoffFailure/);
  assert.match(v38, /humanHandoffPersistencePortFor/);
  assert.doesNotMatch(v38, /HumanHandoffStore/);
  assert.doesNotMatch(v38, /SUPABASE_(?:URL|SECRET_KEY)/);
});
