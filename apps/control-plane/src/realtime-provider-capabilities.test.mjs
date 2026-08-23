import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  REALTIME_TRAFFIC_REQUIRED_CAPABILITIES,
  realtimeProviderCapabilities,
  requireRealtimeProviderCapabilities,
  requireRealtimeProviderTrafficReadiness,
} from "../.test-dist/realtime-provider-capabilities.js";
import { ENABLED_REALTIME_PROVIDERS } from "../.test-dist/realtime-provider-types.js";

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
  "initialInstructionBootstrap",
  "toolCatalogBootstrap",
  "authoritativeTemporalContext",
  "runtimeInstructionPolicyUpdate",
  "runtimeToolCatalogUpdate",
  "correlatedResponseLifecycle",
  "directSip",
];

test("G1/G2 declares every planned provider capability explicitly", () => {
  for (const capability of plannedCapabilities) {
    assert.match(source, new RegExp(`\\b${capability}\\s*:`));
  }
  assert.doesNotMatch(source, /\bdynamicSessionPolicy\s*:/);
});

test("OpenAI capabilities describe product-validated semantics rather than vendor marketing", () => {
  const openai = realtimeProviderCapabilities("OPENAI");
  assert.equal(openai.directSip, true);
  assert.equal(openai.governedSpeech, true);
  assert.equal(openai.isolatedTextDecision, true);
  assert.equal(openai.semanticToolGate, true);
  assert.equal(openai.initialInstructionBootstrap, true);
  assert.equal(openai.toolCatalogBootstrap, true);
  assert.equal(openai.authoritativeTemporalContext, true);
  assert.equal(openai.runtimeInstructionPolicyUpdate, true);
  assert.equal(openai.runtimeToolCatalogUpdate, true);
  assert.equal(openai.correlatedResponseLifecycle, true);
  assert.equal(openai.toolCallCancellation, false);
});

test("Gemini claims only semantics proven by product-owned caller VAD/STT, immutable setup, media, output transcription, function calls and owned lifecycle", () => {
  const gemini = realtimeProviderCapabilities("GEMINI");
  assert.equal(gemini.audioInput, true);
  assert.equal(gemini.audioOutput, true);
  assert.equal(gemini.vad, true);
  assert.equal(gemini.inputTranscription, true);
  assert.equal(gemini.outputTranscription, true);
  assert.equal(gemini.initialInstructionBootstrap, true);
  assert.equal(gemini.toolCatalogBootstrap, true);
  assert.equal(gemini.functionCalling, true);
  assert.equal(gemini.correlatedResponseLifecycle, true);
  for (const capability of plannedCapabilities.filter(
    (name) => ![
      "audioInput",
      "audioOutput",
      "vad",
      "inputTranscription",
      "outputTranscription",
      "initialInstructionBootstrap",
      "toolCatalogBootstrap",
      "functionCalling",
      "correlatedResponseLifecycle",
    ].includes(name),
  )) {
    assert.equal(gemini[capability], false, `${capability} must remain false until its gate is proven`);
  }
});

test("traffic readiness requires semantic temporal grounding, not provider-shaped session mutation", () => {
  const required = new Set(REALTIME_TRAFFIC_REQUIRED_CAPABILITIES);
  for (const capability of [
    "audioInput",
    "audioOutput",
    "vad",
    "interruption",
    "functionCalling",
    "inputTranscription",
    "outputTranscription",
    "governedSpeech",
    "isolatedTextDecision",
    "semanticToolGate",
    "initialInstructionBootstrap",
    "toolCatalogBootstrap",
    "authoritativeTemporalContext",
    "correlatedResponseLifecycle",
  ]) {
    assert.equal(required.has(capability), true, `${capability} is required for live traffic`);
  }
  assert.equal(required.has("runtimeInstructionPolicyUpdate"), false, "temporal grounding may use a provider-specific strategy");
  assert.equal(required.has("runtimeToolCatalogUpdate"), false, "immutable setup may own the tool catalog");
  assert.equal(required.has("directSip"), false, "a media bridge may replace direct SIP");
  assert.equal(required.has("toolCallCancellation"), false, "tool cancellation is optional evidence, not rollback authority");
});

test("session readiness does not collapse bootstrap, temporal semantics and runtime mutation into one vendor flag", () => {
  const required = new Set(REALTIME_TRAFFIC_REQUIRED_CAPABILITIES);
  assert.equal(required.has("initialInstructionBootstrap"), true);
  assert.equal(required.has("toolCatalogBootstrap"), true);
  assert.equal(required.has("authoritativeTemporalContext"), true);
  assert.equal(required.has("runtimeInstructionPolicyUpdate"), false);
  assert.equal(required.has("runtimeToolCatalogUpdate"), false);
  assert.equal(required.has("dynamicSessionPolicy"), false);
});

test("every enabled realtime provider is already traffic-ready", () => {
  for (const provider of ENABLED_REALTIME_PROVIDERS) {
    assert.doesNotThrow(
      () => requireRealtimeProviderTrafficReadiness(provider),
      `${provider} must not enter ENABLED_REALTIME_PROVIDERS before all traffic gates pass`,
    );
  }
});

test("OpenAI is traffic-ready under the current validated baseline", () => {
  assert.equal(requireRealtimeProviderTrafficReadiness("OPENAI"), realtimeProviderCapabilities("OPENAI"));
});

test("Gemini traffic readiness remains closed after caller VAD/STT, media, output transcription, bootstrap, function-calling and lifecycle proof", () => {
  assert.throws(
    () => requireRealtimeProviderTrafficReadiness("GEMINI"),
    /lacks required capabilities: interruption, governedSpeech, isolatedTextDecision, semanticToolGate, authoritativeTemporalContext/,
  );
});

test("runtime binding requires both provider enablement and traffic readiness", () => {
  assert.match(runtime, /requireEnabledRealtimeProvider\(provider\);/);
  assert.match(runtime, /requireRealtimeProviderTrafficReadiness\(provider\);/);
  assert.match(runtime, /export function realtimeCapabilitiesFor/);
});

test("capability requirements fail closed until remaining Gemini runtime gates are implemented", () => {
  assert.throws(
    () => requireRealtimeProviderCapabilities("GEMINI", ["interruption", "semanticToolGate", "authoritativeTemporalContext"]),
    /lacks required capabilities: interruption, semanticToolGate, authoritativeTemporalContext/,
  );
  assert.doesNotThrow(
    () => requireRealtimeProviderCapabilities("GEMINI", [
      "audioInput",
      "audioOutput",
      "vad",
      "inputTranscription",
      "outputTranscription",
      "initialInstructionBootstrap",
      "toolCatalogBootstrap",
      "functionCalling",
      "correlatedResponseLifecycle",
    ]),
  );
  assert.match(source, /if \(!capabilities\) throw new Error/);
});
