import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./call-session-v29.ts", import.meta.url), "utf8");
const bootstrapSource = readFileSync(new URL("./direct-agent-realtime-bootstrap.ts", import.meta.url), "utf8");

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

test("v29 delegates greetings and presence replies to contextual model interpretation", () => {
  assert.match(source, /directAgentInstructions/);
  assert.match(source, /instructions:\s*directAgentInstructions\(this as any\)/);
  assert.match(bootstrapSource, /usa restaurant_conversation/);
  assert.match(bootstrapSource, /No existe una lista cerrada de frases/);
  assert.doesNotMatch(source, /isPureGreetingTurn/);
  assert.doesNotMatch(source, /isPresenceAcknowledgementTurn/);
  assert.doesNotMatch(source, /DETERMINISTIC_GREETING/);
  assert.doesNotMatch(source, /DETERMINISTIC_PRESENCE_ACKNOWLEDGEMENT/);
});

test("v29 installs the canonical semantic confidentiality policy in the final active instructions", () => {
  assert.match(source, /import\s*{\s*directAgentInstructions\s*}\s*from\s*["']\.\/direct-agent-realtime-bootstrap\.js["']/);
  assert.match(source, /instructions:\s*directAgentInstructions\(this as any\)/);
  assert.match(bootstrapSource, /SEMANTIC_SECURITY_POLICY/);
  assert.match(bootstrapSource, /return `\$\{SEMANTIC_SECURITY_POLICY\}/);
  assert.doesNotMatch(source, /function\s+v29Instructions\s*\(/);
});
