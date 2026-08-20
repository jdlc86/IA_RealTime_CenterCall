import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./call-session-v35-runtime.ts", import.meta.url), "utf8");
const v36 = await readFile(new URL("./call-session-v36.ts", import.meta.url), "utf8");

test("v35 protected speech runtime depends only on neutral provider runtime", () => {
  assert.match(source, /adaptRealtimeProviderEvents/);
  assert.match(source, /realtimeCommandPortFor/);
  assert.doesNotMatch(source, /openai-realtime-command-adapter/);
  assert.doesNotMatch(source, /openai-realtime-event-adapter/);
  assert.doesNotMatch(source, /adaptOpenAIRealtimeEvent/);
});

test("v35 keeps the validated atomic greeting lifecycle unchanged", () => {
  assert.match(source, /ATOMIC_GREETING_WATCHDOG_MS = 30_000/);
  assert.match(source, /ATOMIC_GREETING_VAD_SUSPEND_REQUESTED_V35/);
  assert.match(source, /ATOMIC_GREETING_COMPLETED_V35/);
  assert.match(source, /ASSISTANT_AUDIO_STOPPED/);
  assert.match(source, /ASSISTANT_AUDIO_CLEARED/);
});

test("v36 turn concurrency commands also cross the neutral provider runtime boundary", () => {
  assert.match(v36, /realtime-provider-runtime/);
  assert.match(v36, /realtimeCommandPortFor/);
  assert.doesNotMatch(v36, /openai-realtime-command-adapter/);
});
