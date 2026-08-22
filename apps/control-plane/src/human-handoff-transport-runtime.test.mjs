import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HumanHandoffTransportRuntime } from "../.test-dist/human-handoff-transport-runtime.js";
import { humanHandoffTransportPortFor } from "../.test-dist/human-handoff-transport-port.js";

const config = {
  enabled: true,
  destination: { type: "PHONE", phone: "+34910000000", label: "Recepción" },
  transfer: { mode: "BLIND", answerTimeoutSeconds: 25 },
  failurePolicy: { action: "TERMINATE_AND_CALLBACK", message: "No ha sido posible transferir." },
  successMessage: "Te paso con una persona.",
};

test("human handoff runtime owns configuration, transport context and active lifecycle", () => {
  const runtime = new HumanHandoffTransportRuntime();
  runtime.setConfig(config);
  runtime.attachTransportContext("source-1", "+34910000000");
  assert.equal(runtime.getConfig(), config);
  assert.deepEqual(runtime.transportContext(), { sourceCallControlId: "source-1", calledNumber: "+34910000000" });
  assert.equal(runtime.begin({ id: "handoff-1", reason: "REQUESTED", summary: "context" }), true);
  assert.equal(runtime.begin({ id: "handoff-2", reason: "REQUESTED" }), false);
  assert.equal(runtime.snapshot()?.phase, "WAITING_VAD_OFF");
  runtime.beginSpeech("ANNOUNCEMENT");
  assert.equal(runtime.snapshot()?.phase, "ANNOUNCING");
  assert.equal(runtime.bindSpeechResponse("ANNOUNCEMENT", "response-1"), true);
  assert.equal(runtime.snapshot()?.speechResponseId, "response-1");
  runtime.clearSpeech("DIALING");
  assert.equal(runtime.snapshot()?.phase, "DIALING");
});

test("human handoff runtime owns and cancels transfer watchdog", async () => {
  const runtime = new HumanHandoffTransportRuntime();
  let fired = 0;
  runtime.armTransferWatchdog(5, () => { fired += 1; });
  runtime.cancelTransferWatchdog();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fired, 0);
});

test("neutral handoff port marks transfer, persists it and closes through lifecycle authority", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method, body: init?.body });
    return new Response(null, { status: 204 });
  };
  try {
    const lifecycle = [];
    const closes = [];
    const checkpoints = [];
    const host = {
      tenantId: "tenant-1",
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "secret" },
      socket: { close(code, reason) { closes.push({ code, reason }); } },
      diagnostics: { checkpoint(name, data) { checkpoints.push({ name, data }); } },
      observeRealtimeTransportClosedV18(reason) { lifecycle.push(reason); },
    };
    const runtime = humanHandoffTransportPortFor(host);
    const state = (await import("../.test-dist/human-handoff-transport-runtime.js")).humanHandoffTransportRuntimeFor(host);
    state.attachTransportContext("source-1", "+34910000000");
    state.begin({ id: "handoff-1", reason: "REQUESTED" });
    state.setPhase("DIALING");

    await runtime.markTransferred("target-1");

    assert.equal(state.snapshot()?.phase, "TRANSFERRED");
    assert.equal(state.snapshot()?.targetCallControlId, "target-1");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "PATCH");
    assert.match(requests[0].body, /"status":"TRANSFERRED"/);
    assert.deepEqual(lifecycle, ["human_handoff_transferred"]);
    assert.deepEqual(closes, [{ code: 1000, reason: "human_handoff_transferred" }]);
    assert.equal(checkpoints.at(-1)?.name, "HUMAN_HANDOFF_TRANSFERRED_RUNTIME");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("v37 and the handoff port no longer own or reach into historical transport state", async () => {
  const v37 = await readFile(new URL("./call-session-v37.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("./human-handoff-transport-port.ts", import.meta.url), "utf8");

  assert.match(v37, /humanHandoffTransportRuntimeFor/);
  assert.match(v37, /adaptRealtimeProviderEvents/);
  assert.match(v37, /realtimeCommandPortFor/);
  assert.doesNotMatch(v37, /private activeHandoffV37/);
  assert.doesNotMatch(v37, /private handoffTransferWatchdogV37/);
  assert.doesNotMatch(v37, /private handoffSpeechWatchdogV37/);
  assert.doesNotMatch(v37, /private telnyxCallControlIdV37/);
  assert.doesNotMatch(v37, /private calledNumberV37/);
  assert.doesNotMatch(v37, /\.hangupStarted\s*=|\.state\s*=\s*"closing"/);
  assert.doesNotMatch(v37, /type:\s*"conversation\.item\.create"/);
  assert.doesNotMatch(v37, /type:\s*"response\.create"/);
  assert.doesNotMatch(v37, /event\?\.type===?"session\.updated"/);
  assert.doesNotMatch(v37, /output_audio_buffer\.stopped/);

  assert.match(port, /humanHandoffTransportRuntimeFor/);
  assert.doesNotMatch(port, /V37/);
  assert.doesNotMatch(port, /clearTransferWatchdogV37|markHandoffTransferredV37/);
});
