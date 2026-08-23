import {
  parseRealtimeProviderName,
  type RealtimeProviderName,
} from "./realtime-provider-types.js";
import type { RealtimeProviderSelectionSource } from "./realtime-provider-selector.js";

export const REALTIME_PROVIDER_HEADER = "X-IA-Realtime-Provider";
export const REALTIME_PROVIDER_SOURCE_HEADER = "X-IA-Realtime-Provider-Source";

export type RealtimeProviderAffinity = Readonly<{
  provider: RealtimeProviderName;
  source: RealtimeProviderSelectionSource;
}>;

function parseSource(value: unknown): RealtimeProviderSelectionSource {
  if (value === "DEFAULT" || value === "TENANT_CONFIG" || value === "KV_OVERRIDE") return value;
  throw new Error(`Invalid realtime provider affinity source: ${String(value)}`);
}

export function realtimeProviderAffinityHeaders(
  affinity: RealtimeProviderAffinity,
): Array<{ name: string; value: string }> {
  return [
    { name: REALTIME_PROVIDER_HEADER, value: affinity.provider },
    { name: REALTIME_PROVIDER_SOURCE_HEADER, value: affinity.source },
  ];
}

export function parseRealtimeProviderAffinity(
  provider: unknown,
  source: unknown,
): RealtimeProviderAffinity {
  return Object.freeze({
    provider: parseRealtimeProviderName(provider, "realtime provider affinity"),
    source: parseSource(source),
  });
}
