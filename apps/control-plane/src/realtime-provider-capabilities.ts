import type { RealtimeProviderName } from "./realtime-provider-selector.js";

/**
 * Explicit provider feature contract.
 *
 * Gate C intentionally describes the capabilities required/used by the current
 * realtime architecture without assuming feature parity between providers.
 * Adding a provider to the selector must not imply that it supports every
 * capability in this contract.
 */
export type ProviderCapabilities = Readonly<{
  audioInput: boolean;
  audioOutput: boolean;
  vad: boolean;
  interruption: boolean;
  functionCalling: boolean;
  inputTranscription: boolean;
  outputTranscription: boolean;
  directSip: boolean;
}>;

const OPENAI_CAPABILITIES = Object.freeze({
  audioInput: true,
  audioOutput: true,
  vad: true,
  interruption: true,
  functionCalling: true,
  inputTranscription: true,
  outputTranscription: true,
  directSip: true,
} satisfies ProviderCapabilities);

const CAPABILITIES_BY_PROVIDER: Readonly<Record<RealtimeProviderName, ProviderCapabilities>> = Object.freeze({
  OPENAI: OPENAI_CAPABILITIES,
});

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
