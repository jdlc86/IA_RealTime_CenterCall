import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  realtimeProviderCapabilities,
  requireRealtimeProviderCapabilities,
} from "../.test-dist/realtime-provider-capabilities.js";

const source = readFileSync(new URL("./realtime-provider-capabilities.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./realtime-provider-runtime.ts", import.meta.url), "utf8");

test("G1 declares every planned provider capability explicitly", () => {
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

test("G1 registers both providers without claiming unimplemented Gemini parity", () => {
  const openai = realtimeProviderCapabilities("OPENAI");
  const gemini = realtimeProviderCapabilities("GEMINI");
  assert.equal(openai.directSip, true);
  assert.deepEqual(gemini, {
    audioInput: false,
    audioOutput: false,
    vad: false,
    interruption: false,
    functionCalling: false,
    inputTranscription: false,
    outputTranscription: false,
    directSip: false,
  });
});

test("runtime binding requires a capability registration", () => {
  assert.match(runtime, /realtimeProviderCapabilities\(provider\);/);
  assert.match(runtime, /export function realtimeCapabilitiesFor/);
});

test("capability requirements fail closed until Gemini gates are implemented", () => {
  assert.throws(
    () => requireRealtimeProviderCapabilities("GEMINI", ["audioInput", "functionCalling"]),
    /lacks required capabilities: audioInput, functionCalling/,
  );
  assert.match(source, /if \(!capabilities\) throw new Error/);
});
