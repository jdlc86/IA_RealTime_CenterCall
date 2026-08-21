import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const v36 = await readFile(new URL("./call-session-v36.ts", import.meta.url), "utf8");
const coordinator = await readFile(new URL("./turn-concurrency-coordinator.ts", import.meta.url), "utf8");

test("v36 routes turn concurrency through provider-neutral events", () => {
  assert.match(v36, /adaptRealtimeProviderEvents/);
  assert.match(v36, /turnConcurrencyCoordinatorFor/);
  assert.doesNotMatch(v36, /readRealtimeText/);
  assert.doesNotMatch(v36, /parseEventV36/);
  assert.doesNotMatch(v36, /TextDecoder/);
  assert.doesNotMatch(v36, /JSON\.parse/);
  assert.doesNotMatch(v36, /input_audio_buffer\.speech_started/);
  assert.doesNotMatch(v36, /conversation\.item\.input_audio_transcription\.completed/);
  assert.doesNotMatch(v36, /output_audio_buffer\.(?:started|stopped|cleared)/);
});

test("turn concurrency coordinator consumes neutral events and lifecycle authority", () => {
  assert.match(coordinator, /RealtimeProviderEvent/);
  assert.match(coordinator, /CALLER_SPEECH_STARTED/);
  assert.match(coordinator, /CALLER_TRANSCRIPT_COMPLETED/);
  assert.match(coordinator, /ASSISTANT_RESPONSE_STARTED/);
  assert.match(coordinator, /ASSISTANT_AUDIO_STARTED/);
  assert.match(coordinator, /ASSISTANT_AUDIO_STOPPED/);
  assert.match(coordinator, /ASSISTANT_AUDIO_CLEARED/);
  assert.match(coordinator, /conversationLifecyclePortFor\(session\)\.isTerminal\(\)/);
  assert.doesNotMatch(coordinator, /session\.state/);
  assert.doesNotMatch(coordinator, /session\.hangupStarted/);
  assert.doesNotMatch(coordinator, /input_audio_buffer\.speech_started/);
  assert.doesNotMatch(coordinator, /conversation\.item\.input_audio_transcription\.completed/);
  assert.doesNotMatch(coordinator, /output_audio_buffer\.(?:started|stopped|cleared)/);
  assert.doesNotMatch(coordinator, /response\.created/);
});

test("turn concurrency preserves protected greeting and recovery playback semantics", () => {
  assert.match(coordinator, /kind === "GREETING" \|\| kind === "RECOVERY"/);
  assert.match(coordinator, /normal_assistant_playback_started/);
  assert.match(coordinator, /protected_playback_completed/);
  assert.match(coordinator, /TURN_CONCURRENCY_WATCHDOG_V36/);
});
