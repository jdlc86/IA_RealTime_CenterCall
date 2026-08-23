import type { RealtimeProviderName } from "./realtime-provider-types.js";

/**
 * Explicit provider feature contract.
 *
 * Capabilities describe semantics implemented and validated by this product,
 * not merely features advertised by a vendor. A registered provider can expose
 * false capabilities while adapter/media/lifecycle gates are still incomplete.
 */
export type ProviderCapabilities = Readonly<{
  audioInput: boolean;
  audioOutput: boolean;
  vad: boolean;
  interruption: boolean;
  functionCalling: boolean;
  toolCallCancellation: boolean;
  inputTranscription: boolean;
  outputTranscription: boolean;
  governedSpeech: boolean;
  isolatedTextDecision: boolean;
  semanticToolGate: boolean;
  initialInstructionBootstrap: boolean;
  toolCatalogBootstrap: boolean;
  authoritativeTemporalContext: boolean;
  runtimeInstructionPolicyUpdate: boolean;
  runtimeToolCatalogUpdate: boolean;
  correlatedResponseLifecycle: boolean;
  directSip: boolean;
}>;

const OPENAI_CAPABILITIES = Object.freeze({
  audioInput: true,
  audioOutput: true,
  vad: true,
  interruption: true,
  functionCalling: true,
  toolCallCancellation: false,
  inputTranscription: true,
  outputTranscription: true,
  governedSpeech: true,
  isolatedTextDecision: true,
  semanticToolGate: true,
  initialInstructionBootstrap: true,
  toolCatalogBootstrap: true,
  authoritativeTemporalContext: true,
  runtimeInstructionPolicyUpdate: true,
  runtimeToolCatalogUpdate: true,
  correlatedResponseLifecycle: true,
  directSip: true,
} satisfies ProviderCapabilities);

const GEMINI_CAPABILITIES = Object.freeze({
  // G3 media bridge proves ordered Telnyx L16 -> Gemini realtime input and
  // correlated Gemini PCM -> Telnyx playback. Caller VAD is product-owned: a
  // deterministic sample-count detector identifies onset/offset from media
  // samples, retains onset frames, and closes only after configured silence.
  // Caller input transcription is likewise product-owned: the edge freezes the
  // exact detected candidate, sends it to Google Speech-to-Text v2, and rejects
  // any transcript whose item identity differs from the captured candidate. The
  // session owner also correlates output-transcription chunks to its active
  // response and finalizes them only on turnComplete. Traffic remains blocked by
  // the semantic/runtime gates below.
  audioInput: true,
  audioOutput: true,
  vad: true,
  interruption: false,
  functionCalling: true,
  toolCallCancellation: false,
  inputTranscription: true,
  outputTranscription: true,
  governedSpeech: false,
  isolatedTextDecision: false,
  semanticToolGate: false,
  initialInstructionBootstrap: true,
  toolCatalogBootstrap: true,
  authoritativeTemporalContext: false,
  runtimeInstructionPolicyUpdate: false,
  runtimeToolCatalogUpdate: false,
  correlatedResponseLifecycle: true,
  directSip: false,
} satisfies ProviderCapabilities);

const CAPABILITIES_BY_PROVIDER: Readonly<Record<RealtimeProviderName, ProviderCapabilities>> = Object.freeze({
  OPENAI: OPENAI_CAPABILITIES,
  GEMINI: GEMINI_CAPABILITIES,
});

/**
 * Product-level invariants required before a provider may carry live call traffic.
 *
 * directSip is intentionally absent: a provider may satisfy media transport through
 * a bridge. toolCallCancellation is also optional because the core can safely treat
 * cancellation as evidence while preserving ToolGateway ownership.
 *
 * Initial instructions and the tool catalog are bootstrap concerns. They may be
 * composed into an immutable provider session before the call runtime becomes ready,
 * so live traffic requires bootstrap support rather than runtime mutation support.
 * Runtime instruction/tool-catalog mutation remain optional provider capabilities.
 *
 * Authoritative time grounding is required as a semantic capability. The current
 * OpenAI implementation uses a session instruction update, but another provider may
 * satisfy the same contract through a different edge-specific mechanism without
 * exposing that mechanism to V48 or changing provider during a call.
 */
export const REALTIME_TRAFFIC_REQUIRED_CAPABILITIES = Object.freeze([
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
] as const satisfies readonly (keyof ProviderCapabilities)[]);

export function realtimeProviderCapabilities(provider: RealtimeProviderName): ProviderCapabilities {
  const capabilities = CAPABILITIES_BY_PROVIDER[provider];
  if (!capabilities) throw new Error(`Realtime provider capabilities are not registered: ${String(provider)}`);
  return capabilities;
}

export function requireRealtimeProviderCapabilities(
  provider: RealtimeProviderName,
  required: readonly (keyof ProviderCapabilities)[],
): ProviderCapabilities {
  const capabilities = realtimeProviderCapabilities(provider);
  const missing = required.filter((capability) => capabilities[capability] !== true);
  if (missing.length > 0) {
    throw new Error(`Realtime provider ${provider} lacks required capabilities: ${missing.join(", ")}`);
  }
  return capabilities;
}

export function requireRealtimeProviderTrafficReadiness(provider: RealtimeProviderName): ProviderCapabilities {
  return requireRealtimeProviderCapabilities(provider, REALTIME_TRAFFIC_REQUIRED_CAPABILITIES);
}
