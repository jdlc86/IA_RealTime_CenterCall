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
  runtimeInstructionPolicyUpdate: true,
  runtimeToolCatalogUpdate: true,
  correlatedResponseLifecycle: true,
  directSip: true,
} satisfies ProviderCapabilities);

const GEMINI_CAPABILITIES = Object.freeze({
  audioInput: false,
  audioOutput: false,
  vad: false,
  interruption: false,
  functionCalling: false,
  toolCallCancellation: false,
  inputTranscription: false,
  outputTranscription: false,
  governedSpeech: false,
  isolatedTextDecision: false,
  semanticToolGate: false,
  runtimeInstructionPolicyUpdate: false,
  runtimeToolCatalogUpdate: false,
  correlatedResponseLifecycle: false,
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
 * The two runtime session-policy capabilities are intentionally separate. Today the
 * active call runtime still mutates both instructions and the tool catalog after the
 * provider session exists. A future provider may instead compose either concern into
 * immutable bootstrap; that architecture must be proven before either runtime gate is
 * removed from traffic readiness.
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
  "runtimeInstructionPolicyUpdate",
  "runtimeToolCatalogUpdate",
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
