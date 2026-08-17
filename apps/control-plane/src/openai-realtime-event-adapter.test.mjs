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
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "response.created", response: { id: "r1", metadata: { purpose: "presence_recovery_v18" } } })), [{ type: "ASSISTANT_RESPONSE_STARTED", responseId: "r1", purpose: "presence_recovery_v18" }]);
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "output_audio_buffer.started", response_id: "r1", response: { metadata: { protected_speech_v35: "GREETING" } } })), [{ type: "ASSISTANT_AUDIO_STARTED", kind: "GREETING", responseId: "r1" }]);
});

test("OpenAI tool selection becomes semantic tool event", () => {
  assert.deepEqual(adaptOpenAIRealtimeEvent(wire({ type: "response.function_call_arguments.done", name: "restaurant_business_info", arguments: "{}" })), [{ type: "SEMANTIC_TOOL_SELECTED", name: "restaurant_business_info", arguments: "{}" }]);
});
