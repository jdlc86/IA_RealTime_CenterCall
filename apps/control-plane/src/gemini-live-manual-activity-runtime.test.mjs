import assert from "node:assert/strict";
import test from "node:test";
import { buildGeminiLiveInitialSetup } from "../.test-dist/gemini-live-command-adapter.js";
import { GeminiLiveSessionRuntime } from "../.test-dist/gemini-live-session-runtime.js";

function host({ failOn = null } = {}) {
  const sent = [];
  return {
    sent,
    send(message) {
      if (failOn && failOn(message)) throw new Error("wire send failed");
      sent.push(message);
    },
  };
}

function runtimeFor(h, manualActivityDetection = true) {
  const runtime = new GeminiLiveSessionRuntime(h, {
    model: "models/gemini-live-test",
    responseModalities: ["AUDIO"],
    manualActivityDetection,
  });
  runtime.start();
  runtime.observe(JSON.stringify({ setupComplete: {} }));
  return runtime;
}

test("Gemini immutable setup preserves semantic barge-in authority when media edge owns activity boundaries", () => {
  assert.deepEqual(buildGeminiLiveInitialSetup({
    model: "models/gemini-live-test",
    manualActivityDetection: true,
  }), {
    setup: {
      model: "models/gemini-live-test",
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
        activityHandling: "NO_INTERRUPTION",
      },
    },
  });
});

test("manual activity writes exact Gemini realtimeInput boundaries and emits neutral item identity", () => {
  const h = host();
  const runtime = runtimeFor(h);
  const start = runtime.beginCallerActivity();
  assert.deepEqual(h.sent.at(-1), { realtimeInput: { activityStart: {} } });
  assert.deepEqual(start, {
    event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-caller-1" },
    itemId: "gemini-caller-1",
  });

  const end = runtime.endCallerActivity();
  assert.deepEqual(h.sent.at(-1), { realtimeInput: { activityEnd: {} } });
  assert.deepEqual(end, {
    event: { type: "CALLER_SPEECH_STOPPED" },
    itemId: "gemini-caller-1",
  });
});

test("activity boundaries fail closed unless manual detection was declared at immutable setup", () => {
  const h = host();
  const runtime = runtimeFor(h, false);
  const before = h.sent.length;
  assert.throws(() => runtime.beginCallerActivity(), /require manualActivityDetection setup/);
  assert.equal(h.sent.length, before);
});

test("wire failure on activity start leaves local caller ownership unopened", () => {
  const h = host({ failOn: (message) => Boolean(message.realtimeInput?.activityStart) });
  const runtime = runtimeFor(h);
  assert.throws(() => runtime.beginCallerActivity(), /wire send failed/);

  h.send = (message) => h.sent.push(message);
  const start = runtime.beginCallerActivity();
  assert.equal(start.itemId, "gemini-caller-1");
});

test("wire failure on activity end preserves active caller ownership", () => {
  const h = host({ failOn: (message) => Boolean(message.realtimeInput?.activityEnd) });
  const runtime = runtimeFor(h);
  const start = runtime.beginCallerActivity();
  assert.throws(() => runtime.endCallerActivity(), /wire send failed/);

  h.send = (message) => h.sent.push(message);
  const end = runtime.endCallerActivity();
  assert.equal(end.itemId, start.itemId);
});

test("manual activity boundaries never manufacture caller transcript completion", () => {
  const h = host();
  const runtime = runtimeFor(h);
  const events = [runtime.beginCallerActivity().event, runtime.endCallerActivity().event];
  assert.equal(events.some((event) => event.type === "CALLER_TRANSCRIPT_COMPLETED"), false);
});
