import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./realtime-provider-capabilities.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./realtime-provider-runtime.ts", import.meta.url), "utf8");

test("Gate C declares every planned provider capability explicitly", () => {
  for (const capability of [
    "audioInput",
    "audioOutput",
    "vad",
    "interruption",
    "functionCalling",
    "inputTranscription",
    "outputTranscription",
    "directSip",
  ]) {
    assert.match(source, new RegExp(`\\b${capability}\\s*:`));
  }
});

test("OpenAI current architecture is represented explicitly without registering Gemini", () => {
  assert.match(source, /OPENAI_CAPABILITIES/);
  assert.match(source, /directSip:\s*true/);
  assert.doesNotMatch(source, /GEMINI\s*:/);
});

test("runtime binding requires a capability registration", () => {
  assert.match(runtime, /realtimeProviderCapabilities\(provider\);/);
  assert.match(runtime, /export function realtimeCapabilitiesFor/);
});

test("capability lookup fails closed when a registration is missing", () => {
  assert.match(source, /if \(!capabilities\) throw new Error/);
  assert.match(source, /lacks required capabilities/);
});
