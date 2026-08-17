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

test("provider-neutral text decision maps to isolated OpenAI text response", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.requestTextDecision({
    requestId: "classifier-1",
    purpose: "barge_in_classifier_rebuild",
    metadata: { source_item_id: "item-1" },
    maxOutputTokens: 8,
    instructions: "Return INTERRUPT or IGNORE",
    inputText: "Transcripción: espera",
  });

  assert.deepEqual(h.events, [{
    event_id: "classifier-1",
    type: "response.create",
    response: {
      conversation: "none",
      output_modalities: ["text"],
      tool_choice: "none",
      instructions: "Return INTERRUPT or IGNORE",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Transcripción: espera" }] }],
      max_output_tokens: 8,
      metadata: { source_item_id: "item-1", purpose: "barge_in_classifier_rebuild" },
    },
  }]);
});

test("provider commands preserve current OpenAI VAD playback and input-discard semantics", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.suspendInputDetection();
  port.clearInput();
  port.discardInputItem("item-7");
  port.clearPlayback();
  port.cancelResponse("resp-7");
  port.createDefaultResponse();
  port.restoreInputDetection({ threshold: 0.7, prefixPaddingMs: 120, silenceDurationMs: 640, idleTimeoutMs: 9000 });

  assert.equal(h.events[0].type, "session.update");
  assert.equal(h.events[0].session.audio.input.turn_detection, null);
  assert.deepEqual(h.events.slice(1, 6), [
    { type: "input_audio_buffer.clear" },
    { type: "conversation.item.delete", item_id: "item-7" },
    { type: "output_audio_buffer.clear" },
    { type: "response.cancel", response_id: "resp-7" },
    { type: "response.create" },
  ]);
  assert.equal(h.events[6].session.audio.input.turn_detection.type, "server_vad");
  assert.equal(h.events[6].session.audio.input.turn_detection.threshold, 0.7);
});

test("non-interrupting listening preserves VAD thresholds but disables automatic response effects", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.beginNonInterruptingListening({ threshold: 0.61, prefixPaddingMs: 150, silenceDurationMs: 720, idleTimeoutMs: 8000 });

  const turnDetection = h.events[0].session.audio.input.turn_detection;
  assert.equal(h.events[0].type, "session.update");
  assert.equal(turnDetection.type, "server_vad");
  assert.equal(turnDetection.threshold, 0.61);
  assert.equal(turnDetection.prefix_padding_ms, 150);
  assert.equal(turnDetection.silence_duration_ms, 720);
  assert.equal(turnDetection.idle_timeout_ms, 8000);
  assert.equal(turnDetection.create_response, false);
  assert.equal(turnDetection.interrupt_response, false);
});

test("one command port instance is shared per CallSession host", () => {
  const h = host();
  assert.equal(realtimeCommandPortFor(h), realtimeCommandPortFor(h));
  assert.notEqual(realtimeCommandPortFor(h), realtimeCommandPortFor(host()));
});
