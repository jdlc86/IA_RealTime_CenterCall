import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const legacy = await readFile(new URL("./call-session-v35.ts", import.meta.url), "utf8");
const source = await readFile(new URL("./call-session-v35-runtime.ts", import.meta.url), "utf8");
const v36 = await readFile(new URL("./call-session-v36.ts", import.meta.url), "utf8");
const coordinator = await readFile(new URL("./turn-concurrency-coordinator.ts", import.meta.url), "utf8");

test("v35 protected speech layers depend only on neutral provider runtime", () => {
  for (const candidate of [legacy, source]) {
    assert.match(candidate, /adaptRealtimeProviderEvents/);
    assert.match(candidate, /realtimeCommandPortFor/);
    assert.doesNotMatch(candidate, /openai-realtime-command-adapter/);
    assert.doesNotMatch(candidate, /openai-realtime-event-adapter/);
    assert.doesNotMatch(candidate, /adaptOpenAIRealtimeEvent/);
  }

  assert.match(legacy, /beginNonInterruptingListening/);
  assert.match(legacy, /restoreInputDetection/);
  assert.match(legacy, /PROVIDER_COMMAND_FAILED/);
  assert.doesNotMatch(legacy, /type:\s*"session\.update"/);
  assert.doesNotMatch(legacy, /type:\s*"response\.create"/);
  assert.doesNotMatch(legacy, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(legacy, /event\.type === "output_audio_buffer/);
  assert.doesNotMatch(legacy, /\.send\?\.\(/);
});

test("v35 keeps the validated atomic greeting lifecycle unchanged", () => {
  assert.match(source, /ATOMIC_GREETING_WATCHDOG_MS = 30_000/);
  assert.match(source, /ATOMIC_GREETING_VAD_SUSPEND_REQUESTED_V35/);
  assert.match(source, /ATOMIC_GREETING_COMPLETED_V35/);
  assert.match(source, /ASSISTANT_AUDIO_STOPPED/);
  assert.match(source, /ASSISTANT_AUDIO_CLEARED/);
});

test("v36 delegates turn concurrency through neutral provider events and runtime commands", () => {
  assert.match(v36, /turnConcurrencyCoordinatorFor/);
  assert.match(v36, /adaptRealtimeProviderEvents/);
  assert.match(v36, /coordinator\.observe\(session, event\)/);
  assert.doesNotMatch(v36, /parseEvent|readRealtimeText|TextDecoder/);
  assert.doesNotMatch(v36, /realtimeCommandPortFor/);
  assert.doesNotMatch(v36, /openai-realtime-command-adapter/);

  assert.match(coordinator, /realtime-provider-runtime/);
  assert.match(coordinator, /realtimeCommandPortFor/);
  assert.match(coordinator, /RealtimeProviderEvent/);
  assert.doesNotMatch(coordinator, /openai-realtime-command-adapter/);
});