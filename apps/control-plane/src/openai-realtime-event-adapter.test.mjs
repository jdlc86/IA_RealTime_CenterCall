import test from "node:test";
import assert from "node:assert/strict";
import { adaptOpenAIRealtimeEvent } from "../.test-dist/openai-realtime-event-adapter.js";

function wire(event) { return JSON.stringify(event); }

test("OpenAI speech and transcript events become provider-neutral events", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "input_audio_buffer.speech_started" })), [{ type: "CALLER_SPEECH_STARTED" }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "input_audio_buffer.speech_stopped" })), [{ type: "CALLER_SPEECH_STOPPED" }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "conversation.item.input_audio_transcription.completed", transcript: "hola" })), [{ type: "CALLER_TRANSCRIPT_COMPLETED", transcript: "hola" }]);
});

test("OpenAI response metadata maps protected speech and purpose without leaking wire names", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "response.created", response: { id: "r1", metadata: { purpose: "presence_recovery_v18" } } })), [{ type: "ASSISTANT_RESPONSE_STARTED", kind: "PRESENCE", responseId: "r1", purpose: "presence_recovery_v18" }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "response.created", response: { id: "g1", metadata: { protected_speech_v35: "GREETING" } } })), [{ type: "ASSISTANT_RESPONSE_STARTED", kind: "GREETING", responseId: "g1", purpose: undefined }]);
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
