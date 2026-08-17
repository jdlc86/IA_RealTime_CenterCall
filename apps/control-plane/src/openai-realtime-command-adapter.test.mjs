import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIRealtimeCommandAdapter, realtimeCommandPortFor } from "../.test-dist/openai-realtime-command-adapter.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

test("isolated speech is translated without leaking OpenAI protocol into caller", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.speak({
    requestId: "req-1",
    purpose: "presence",
    isolated: true,
    tools: "DISABLED",
    instructions: "Say presence check",
    exactText: "¿Sigues ahí?",
  });
  assert.deepEqual(h.events, [{
    event_id: "req-1",
    type: "response.create",
    response: {
      instructions: "Say presence check",
      conversation: "none",
      tool_choice: "none",
      metadata: { purpose: "presence" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "¿Sigues ahí?" }] }],
    },
  }]);
});

test("provider commands preserve current OpenAI VAD and playback semantics", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.suspendInputDetection();
  port.clearInput();
  port.clearPlayback();
  port.cancelResponse("resp-7");
  port.createDefaultResponse();
  port.restoreInputDetection({ threshold: 0.7, prefixPaddingMs: 120, silenceDurationMs: 640, idleTimeoutMs: 9000 });

  assert.equal(h.events[0].type, "session.update");
  assert.equal(h.events[0].session.audio.input.turn_detection, null);
  assert.deepEqual(h.events.slice(1, 5), [
    { type: "input_audio_buffer.clear" },
    { type: "output_audio_buffer.clear" },
    { type: "response.cancel", response_id: "resp-7" },
    { type: "response.create" },
  ]);
  assert.equal(h.events[5].session.audio.input.turn_detection.type, "server_vad");
  assert.equal(h.events[5].session.audio.input.turn_detection.threshold, 0.7);
});

test("one command port instance is shared per CallSession host", () => {
  const h = host();
  assert.equal(realtimeCommandPortFor(h), realtimeCommandPortFor(h));
  assert.notEqual(realtimeCommandPortFor(h), realtimeCommandPortFor(host()));
});
