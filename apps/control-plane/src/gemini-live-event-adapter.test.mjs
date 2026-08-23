import assert from "node:assert/strict";
import test from "node:test";
import { adaptGeminiLiveEvent } from "./gemini-live-event-adapter.ts";

test("Gemini Live preserves function-call identity and structured arguments", () => {
  assert.deepEqual(adaptGeminiLiveEvent(JSON.stringify({
    toolCall: {
      functionCalls: [{ id: "fc_123", name: "restaurant_reservation_search", args: { party_size: 4 } }],
    },
  })), [{
    type: "SEMANTIC_TOOL_SELECTED",
    name: "restaurant_reservation_search",
    arguments: JSON.stringify({ party_size: 4 }),
    callId: "fc_123",
  }]);
});

test("Gemini Live transcript chunks are not promoted to completed core transcripts", () => {
  assert.deepEqual(adaptGeminiLiveEvent(JSON.stringify({
    serverContent: {
      inputTranscription: { text: "Quiero reservar mañana" },
      outputTranscription: { text: "Claro" },
    },
  })), []);
});

test("Gemini Live generation lifecycle remains edge evidence until stateful correlation exists", () => {
  assert.deepEqual(adaptGeminiLiveEvent(JSON.stringify({
    serverContent: { generationComplete: true, turnComplete: true, interrupted: true },
  })), []);
});

test("Gemini Live tool cancellation is not misreported as semantic completion", () => {
  assert.deepEqual(adaptGeminiLiveEvent(JSON.stringify({ toolCallCancellation: { ids: ["fc_123"] } })), []);
});

test("Gemini Live normalizes provider errors without exposing wire to core", () => {
  assert.deepEqual(adaptGeminiLiveEvent(JSON.stringify({
    error: { code: 1007, message: "invalid argument" },
  })), [{ type: "PROVIDER_COMMAND_FAILED", code: "1007", message: "invalid argument" }]);
});
