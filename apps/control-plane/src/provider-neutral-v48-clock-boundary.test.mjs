import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v48-authoritative-clock.ts", import.meta.url), "utf8");

test("v48 consumes caller transcripts through the provider-neutral event boundary", () => {
  assert.match(source, /adaptRealtimeProviderEvents/);
  assert.match(source, /CALLER_TRANSCRIPT_COMPLETED/);
  assert.match(source, /event\.itemId/);
  assert.doesNotMatch(source, /conversation\.item\.input_audio_transcription\.completed/);
  assert.doesNotMatch(source, /event\.item_id/);
});

test("v48 refreshes authoritative time through a semantic temporal-context capability", () => {
  assert.match(source, /installRealtimeSessionPolicyTransform/);
  assert.match(source, /authoritativeTemporalContextPortFor/);
  assert.match(source, /\.refresh\(\{/);
  assert.match(source, /AUTHORITATIVE_CLOCK_INJECTED_V48/);
  assert.match(source, /AUTHORITATIVE_CLOCK_REFRESHED_FOR_CALLER_TURN_V48/);
  assert.match(source, /conversationLifecyclePortFor/);
  assert.match(source, /\.isTerminal\(\)/);
  assert.doesNotMatch(source, /realtimeCommandPortFor/);
  assert.doesNotMatch(source, /updateSessionPolicy/);
  assert.doesNotMatch(source, /Compatibility fallback for historical layers/);
  assert.doesNotMatch(source, /originalSendV48/);
  assert.doesNotMatch(source, /session\.send\s*=/);
  assert.doesNotMatch(source, /session\.update/);
  assert.doesNotMatch(source, /hangupStarted/);
  assert.doesNotMatch(source, /\.state\s*===\s*["']closing["']/);
});

test("v48 adds no timer or sleep during provider-neutral refactor", () => {
  assert.doesNotMatch(source, /setTimeout\s*\(/);
  assert.doesNotMatch(source, /sleep\s*\(/);
});
