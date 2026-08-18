import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_REALTIME_PROVIDER,
  adaptRealtimeProviderEvents,
  realtimeCommandPortFor,
} from "../.test-dist/realtime-provider-runtime.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

function wire(event) { return JSON.stringify(event); }

test("provider runtime keeps OpenAI as the only active provider during neutrality refactor", () => {
  assert.equal(ACTIVE_REALTIME_PROVIDER, "OPENAI");
});

test("neutral command access preserves the existing OpenAI wire behavior", () => {
  const h = host();
  const port = realtimeCommandPortFor(h);
  port.speak({ instructions: "hola", tools: "DISABLED", purpose: "neutrality-gate" });

  assert.deepEqual(h.events, [{
    type: "response.create",
    response: {
      instructions: "hola",
      tool_choice: "none",
      metadata: { purpose: "neutrality-gate" },
    },
  }]);
});

test("neutral event access delegates current OpenAI wire events without semantic change", () => {
  assert.deepEqual(
    adaptRealtimeProviderEvents(wire({ type: "input_audio_buffer.speech_started" })),
    [{ type: "CALLER_SPEECH_STARTED" }],
  );
});

test("neutral command access preserves one adapter instance per host", () => {
  const h = host();
  assert.equal(realtimeCommandPortFor(h), realtimeCommandPortFor(h));
  assert.notEqual(realtimeCommandPortFor(h), realtimeCommandPortFor(host()));
});
