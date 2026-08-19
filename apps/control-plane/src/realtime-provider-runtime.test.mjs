import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_REALTIME_PROVIDER,
  adaptRealtimeProviderEvents,
  bindRealtimeProvider,
  installRealtimeToolResultPolicy,
  realtimeCommandPortFor,
  realtimeProviderFor,
} from "../.test-dist/realtime-provider-runtime.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

function wire(event) { return JSON.stringify(event); }

test("provider runtime keeps OpenAI as the only active provider during Gate A", () => {
  assert.equal(ACTIVE_REALTIME_PROVIDER, "OPENAI");
});

test("Gate A binds the selected provider before command runtime creation", () => {
  const h = host();
  bindRealtimeProvider(h, "OPENAI");
  assert.equal(realtimeProviderFor(h), "OPENAI");
  const port = realtimeCommandPortFor(h);
  port.speak({ instructions: "hola", tools: "DISABLED", purpose: "provider-selector-gate-a" });
  assert.equal(h.events[0]?.type, "response.create");
});

test("Gate A rejects an unregistered provider at the runtime boundary", () => {
  const h = host();
  assert.throws(() => bindRealtimeProvider(h, "GEMINI"), /not registered/);
  assert.equal(realtimeProviderFor(h), "OPENAI");
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

test("neutral tool-result policy can replace only the following default response", () => {
  const h = host();
  installRealtimeToolResultPolicy(h, (request) => {
    if (request.callId !== "call-terminal") return { action: "PASS" };
    return {
      action: "REPLACE_DEFAULT_RESPONSE",
      speech: {
        instructions: "resultado gobernado",
        tools: "DISABLED",
        purpose: "direct_post_tool_terminal_v26",
      },
    };
  });
  const port = realtimeCommandPortFor(h);

  port.submitToolResult({ callId: "call-terminal", output: { ok: true, status: "FOUND" } });
  port.createDefaultResponse();

  assert.deepEqual(h.events, [
    {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-terminal",
        output: '{"ok":true,"status":"FOUND"}',
      },
    },
    {
      type: "response.create",
      response: {
        instructions: "resultado gobernado",
        tool_choice: "none",
        metadata: { purpose: "direct_post_tool_terminal_v26" },
      },
    },
  ]);
});

test("neutral tool-result policy preserves normal default response wire behavior", () => {
  const h = host();
  installRealtimeToolResultPolicy(h, () => ({ action: "PASS" }));
  const port = realtimeCommandPortFor(h);
  port.submitToolResult({ callId: "call-normal", output: { ok: true, status: "READY_TO_CONFIRM" } });
  port.createDefaultResponse();
  assert.deepEqual(h.events[1], { type: "response.create" });
});

test("a later tool result clears any earlier pending default-response replacement", () => {
  const h = host();
  installRealtimeToolResultPolicy(h, (request) => request.callId === "first"
    ? { action: "REPLACE_DEFAULT_RESPONSE", speech: { instructions: "replace" } }
    : { action: "PASS" });
  const port = realtimeCommandPortFor(h);
  port.submitToolResult({ callId: "first", output: { ok: true } });
  port.submitToolResult({ callId: "second", output: { ok: true } });
  port.createDefaultResponse();
  assert.deepEqual(h.events.at(-1), { type: "response.create" });
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
