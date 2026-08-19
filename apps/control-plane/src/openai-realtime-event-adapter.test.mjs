import test from "node:test";
import assert from "node:assert/strict";
import { adaptOpenAIRealtimeEvent } from "../.test-dist/openai-realtime-event-adapter.js";

function wire(event) { return JSON.stringify(event); }

test("OpenAI speech and transcript events become provider-neutral events", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "input_audio_buffer.speech_started" })), [{ type: "CALLER_SPEECH_STARTED" }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "input_audio_buffer.speech_stopped" })), [{ type: "CALLER_SPEECH_STOPPED" }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "conversation.item.input_audio_transcription.completed", transcript: "hola" })), [{ type: "CALLER_TRANSCRIPT_COMPLETED", transcript: "hola" }]);
});

test("OpenAI caller transcript identity is preserved only when provider supplies it", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-1",
    transcript: "hola",
  })), [{ type: "CALLER_TRANSCRIPT_COMPLETED", transcript: "hola", itemId: "item-1" }]);
});

test("OpenAI assistant audio transcript becomes provider-neutral transcript evidence", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({
    type: "response.output_audio_transcript.done",
    response_id: "resp-1",
    transcript: "¿Necesitas algo más en lo que pueda ayudarte?",
  })), [{
    type: "ASSISTANT_TRANSCRIPT_COMPLETED",
    transcript: "¿Necesitas algo más en lo que pueda ayudarte?",
    responseId: "resp-1",
  }]);
});

test("OpenAI isolated text decision preserves correlation without leaking wire names", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({
    type: "response.created",
    response: { id: "classifier-1", metadata: { purpose: "barge_in_classifier_rebuild", source_item_id: "item-1" } },
  })), [{
    type: "ASSISTANT_RESPONSE_STARTED",
    kind: "NORMAL",
    responseId: "classifier-1",
    purpose: "barge_in_classifier_rebuild",
    sourceItemId: "item-1",
  }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({
    type: "response.output_text.done",
    response_id: "classifier-1",
    text: "INTERRUPT",
  })), [{ type: "TEXT_DECISION_COMPLETED", responseId: "classifier-1", text: "INTERRUPT" }]);
});

test("OpenAI response metadata maps protected speech, handoff and purpose", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "response.created", response: { id: "r1", metadata: { purpose: "presence_recovery_v18" } } })), [{ type: "ASSISTANT_RESPONSE_STARTED", kind: "PRESENCE", responseId: "r1", purpose: "presence_recovery_v18", sourceItemId: undefined }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "response.created", response: { id: "g1", metadata: { protected_speech_v35: "GREETING" } } })), [{ type: "ASSISTANT_RESPONSE_STARTED", kind: "GREETING", responseId: "g1", purpose: undefined, sourceItemId: undefined }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "response.created", response: { id: "h1", metadata: { human_handoff_v37: "announcement" } } })), [{ type: "ASSISTANT_RESPONSE_STARTED", kind: "HANDOFF", responseId: "h1", purpose: undefined, sourceItemId: undefined }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "output_audio_buffer.started", response_id: "r1", response: { metadata: { protected_speech_v35: "GREETING" } } })), [{ type: "ASSISTANT_AUDIO_STARTED", kind: "GREETING", responseId: "r1" }]);
});

test("OpenAI session turn detection becomes provider-neutral effective input detection", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({
    type: "session.updated",
    session: { audio: { input: { turn_detection: null } } },
  })), [{ type: "INPUT_DETECTION_UPDATED", present: true, settings: null }]);

  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({
    type: "session.updated",
    session: { audio: { input: { turn_detection: {
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
      idle_timeout_ms: 10000,
      create_response: false,
      interrupt_response: false,
    } } } },
  })), [{
    type: "INPUT_DETECTION_UPDATED",
    present: true,
    settings: {
      threshold: 0.5,
      prefixPaddingMs: 300,
      silenceDurationMs: 500,
      idleTimeoutMs: 10000,
      createResponse: false,
      interruptResponse: false,
    },
  }]);
});

test("OpenAI completion and playback clear become provider-neutral terminal observations", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "output_audio_buffer.cleared", response_id: "g1" })), [{ type: "ASSISTANT_AUDIO_CLEARED", kind: "NORMAL", responseId: "g1" }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "response.done", response: { id: "g1", status: "failed", metadata: { protected_speech_v35: "GREETING" } } })), [{ type: "ASSISTANT_RESPONSE_COMPLETED", kind: "GREETING", responseId: "g1", status: "failed" }]);
});

test("OpenAI tool selection becomes semantic tool event", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "response.function_call_arguments.done", name: "restaurant_business_info", arguments: "{}" })), [{ type: "SEMANTIC_TOOL_SELECTED", name: "restaurant_business_info", arguments: "{}" }]);
});

test("OpenAI tool call identity is preserved for provider-neutral tool response correlation", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({
    type: "response.function_call_arguments.done",
    name: "restaurant_business_info",
    arguments: "{}",
    call_id: "call-1",
  })), [{ type: "SEMANTIC_TOOL_SELECTED", name: "restaurant_business_info", arguments: "{}", callId: "call-1" }]);
});
