import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("Gate B keeps V40 behind the provider-neutral runtime boundary", async () => {
  const text = await source("call-session-v40-rebuild.ts");
  assert.match(text, /realtime-provider-runtime/);
  assert.match(text, /adaptRealtimeProviderEvents/);
  assert.doesNotMatch(text, /openai-realtime-command-adapter/);
  assert.doesNotMatch(text, /input_audio_buffer\./);
  assert.doesNotMatch(text, /output_audio_buffer\./);
  assert.doesNotMatch(text, /response\.created/);
  assert.doesNotMatch(text, /response\.output_text\.done/);
});

test("Gate B keeps V44 raw-VAD routing provider-neutral", async () => {
  const text = await source("call-session-v44-raw-vad-routing.ts");
  assert.match(text, /adaptRealtimeProviderEvents/);
  assert.doesNotMatch(text, /input_audio_buffer\./);
  assert.doesNotMatch(text, /output_audio_buffer\./);
  assert.doesNotMatch(text, /response\.created/);
});
