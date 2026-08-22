import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./call-session-v29.ts", import.meta.url), "utf8");

test("v29 consumes inbound realtime facts only through provider-neutral events", () => {
  assert.match(source, /adaptRealtimeProviderEvents/);
  assert.match(source, /CALLER_SPEECH_STARTED/);
  assert.match(source, /CALLER_TRANSCRIPT_COMPLETED/);
  assert.match(source, /SEMANTIC_TOOL_SELECTED/);
  assert.match(source, /toolEvent\.callId/);
  assert.match(source, /transcriptEvent\.itemId/);

  assert.doesNotMatch(source, /readRealtimeText/);
  assert.doesNotMatch(source, /parseEvent/);
  assert.doesNotMatch(source, /TextDecoder/);
  assert.doesNotMatch(source, /input_audio_buffer\.speech_started/);
  assert.doesNotMatch(source, /conversation\.item\.input_audio_transcription\.completed/);
  assert.doesNotMatch(source, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(source, /event\.item_id/);
});

test("v29 preserves lower compatibility dispatch after neutral event adaptation", () => {
  assert.match(source, /V26Prototype\.handleRealtimeMessage\.call\(this, data\)/);
  assert.match(source, /BasePrototype\.handleRealtimeMessage\.call\(this, data\)/);
  assert.match(source, /source:\s*"v29_provider_event_adapter"/);
});

test("v29 answers a pure greeting without arming backend tools or contextual close", () => {
  assert.match(source, /isPureGreetingTurn\(transcript\)/);
  assert.match(source, /purpose:\s*"pure_greeting_v29"/);
  assert.match(source, /backend_tool_authority:\s*false/);
  assert.match(source, /contextual_close_question:\s*false/);
  assert.match(source, /semantic_gate_armed:\s*false/);
  assert.match(source, /PURE_GREETING_HANDLED_V29/);
});

test("v29 resolves a contextual presence acknowledgement without model tool classification", () => {
  assert.match(source, /lifecycle\.isAwaitingPresenceReply\(\)/);
  assert.match(source, /isPresenceAcknowledgementTurn\(transcript\)/);
  assert.match(source, /lifecycle\.acknowledgePresence\("deterministic_transcript_v29"\)/);
  assert.match(source, /purpose:\s*"presence_acknowledgement_v29"/);
  assert.match(source, /model_classification_bypassed:\s*true/);
  assert.match(source, /USER_PRESENCE_ACKNOWLEDGEMENT_HANDLED_V29/);
});
