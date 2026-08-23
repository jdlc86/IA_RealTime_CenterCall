import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  realtimeProviderCapabilities,
  requireRealtimeProviderCapabilities,
} from "../.test-dist/realtime-provider-capabilities.js";

const source = readFileSync(new URL("./realtime-provider-capabilities.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./realtime-provider-runtime.ts", import.meta.url), "utf8");

const plannedCapabilities = [
  "audioInput",
  "audioOutput",
  "vad",
  "interruption",
  "functionCalling",
  "toolCallCancellation",
  "inputTranscription",
  "outputTranscription",
  "governedSpeech",
  "isolatedTextDecision",
  "semanticToolGate",
  "dynamicSessionPolicy",
  "correlatedResponseLifecycle",
  "directSip",
];

test("G1/G2 declares every planned provider capability explicitly", () => {
  for (const capability of plannedCapabilities) {
    assert.match(source, new RegExp(`\\b${capability}\\s*:`));
  }
});

test("OpenAI capabilities describe product-validated semantics rather than vendor marketing", () => {
  const openai = realtimeProviderCapabilities("OPENAI");
  assert.equal(openai.directSip, true);
  assert.equal(openai.governedSpeech, true);
  assert.equal(openai.isolatedTextDecision, true);
  assert.equal(openai.semanticToolGate, true);
  assert.equal(openai.dynamicSessionPolicy, true);
  assert.equal(openai.correlatedResponseLifecycle, true);
  assert.equal(openai.toolCallCancellation, false);
});

test("Gemini remains registered without claiming any unvalidated parity", () => {
  const gemini = realtimeProviderCapabilities("GEMINI");
  for (const capability of plannedCapabilities) {
    assert.equal(gemini[capability], false, `${capability} must remain false until its gate is proven`);
  }
});

test("runtime binding requires a capability registration", () => {
  assert.match(runtime, /realtimeProviderCapabilities\(provider\);/);
  assert.match(runtime, /export function realtimeCapabilitiesFor/);
});

test("capability requirements fail closed until Gemini gates are implemented", () => {
  assert.throws(
    () => requireRealtimeProviderCapabilities("GEMINI", ["audioInput", "functionCalling", "semanticToolGate", "correlatedResponseLifecycle"]),
    /lacks required capabilities: audioInput, functionCalling, semanticToolGate, correlatedResponseLifecycle/,
  );
  assert.match(source, /if \(!capabilities\) throw new Error/);
});
