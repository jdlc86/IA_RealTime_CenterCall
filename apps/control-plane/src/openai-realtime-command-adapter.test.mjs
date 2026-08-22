import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAIRealtimeCommandAdapter,
  normalizeOpenAIResponseMetadata,
  realtimeCommandPortFor,
} from "../.test-dist/openai-realtime-command-adapter.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

test("isolated exact speech is response-local system authority, never a synthetic caller turn", () => {
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
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].event_id, "req-1");
  assert.equal(h.events[0].type, "response.create");
  assert.equal(h.events[0].response.conversation, "none");
  assert.equal(h.events[0].response.tool_choice, "none");
  assert.deepEqual(h.events[0].response.metadata, { purpose: "presence" });
  assert.match(h.events[0].response.instructions, /Say presence check/);
  assert.match(h.events[0].response.instructions, /¿Sigues ahí\?/);
  assert.equal(h.events[0].response.input[0].role, "system");
  assert.match(h.events[0].response.input[0].content[0].text, /¿Sigues ahí\?/);
  assert.doesNotMatch(h.events[0].response.input[0].content[0].text, /responde a ese texto/i);
});

test("governed availability-conflict speech cannot be injected as user input", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  const speech = "Perdona, pero lamentablemente, no se ha creado ninguna reserva para ti.";

  port.speak({
    instructions: `Pronuncia exactamente: ${JSON.stringify(speech)}`,
    exactText: speech,
    tools: "DISABLED",
    purpose: "reservation_availability_changed_v26",
  });

  const response = h.events[0].response;
  assert.equal(response.input[0].role, "system");
  assert.equal(response.input.some((item) => item.role === "user"), false);
  assert.match(response.instructions, /no lo parafrasees/i);
  assert.match(response.instructions, /no se ha creado ninguna reserva para ti/i);
});

test("OpenAI response metadata values are always strings", () => {
  assert.deepEqual(normalizeOpenAIResponseMetadata({
    pending_close: true,
    turn_id: 7,
    purpose: "close_confirmation_v41",
    nested: { source: "v41" },
  }), {
    pending_close: "true",
    turn_id: "7",
    purpose: "close_confirmation_v41",
    nested: '{"source":"v41"}',
  });
});

test("v41 close confirmation metadata cannot emit invalid boolean metadata", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.speak({
    purpose: "close_confirmation_v41",
    isolated: true,
    tools: "DISABLED",
    instructions: "Pregunta si quiere terminar",
    exactText: "¿Quieres terminar la llamada?",
    metadata: {
      pending_close: true,
      confidence: 1,
    },
  });

  assert.deepEqual(h.events[0].response.metadata, {
    pending_close: "true",
    confidence: "1",
    purpose: "close_confirmation_v41",
  });
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

test("text-decision metadata is normalized through the same adapter boundary", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.requestTextDecision({
    instructions: "Clasifica",
    inputText: "hasta luego",
    metadata: { semantic_turn: 3, confirmed: false },
  });

  assert.deepEqual(h.events[0].response.metadata, {
    semantic_turn: "3",
    confirmed: "false",
  });
});

test("semantic caller turn is persisted before inference so tool outputs can reference its calls", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.createSemanticResponse({
    requestId: "semantic-1",
    purpose: "consolidated_caller_turn",
    callerTurnText: "a las nueve y media",
    metadata: { consolidated_caller_turn: true },
  });

  assert.equal(h.events.length, 2);
  assert.equal(h.events[0].type, "conversation.item.create");
  assert.equal(h.events[0].item.type, "message");
  assert.equal(h.events[0].item.role, "user");
  assert.match(h.events[0].item.content[0].text, /a las nueve y media/);
  assert.deepEqual(h.events[1], {
    event_id: "semantic-1",
    type: "response.create",
    response: {
      metadata: {
        consolidated_caller_turn: "true",
        purpose: "consolidated_caller_turn",
      },
    },
  });
});

test("provider-neutral tool result preserves current OpenAI function output wire format", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.submitToolResult({
    callId: "call-17",
    toolName: "restaurant_reservation_query",
    output: { ok: true, status: "FOUND", count: 1 },
  });

  assert.deepEqual(h.events, [{
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: "call-17",
      output: '{"ok":true,"status":"FOUND","count":1}',
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
