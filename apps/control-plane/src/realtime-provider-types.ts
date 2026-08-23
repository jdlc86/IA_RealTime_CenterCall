export const REGISTERED_REALTIME_PROVIDERS = ["OPENAI", "GEMINI"] as const;
export type RealtimeProviderName = (typeof REGISTERED_REALTIME_PROVIDERS)[number];

export const ENABLED_REALTIME_PROVIDERS = ["OPENAI"] as const;
export type EnabledRealtimeProviderName = (typeof ENABLED_REALTIME_PROVIDERS)[number];

export const DEFAULT_REALTIME_PROVIDER: RealtimeProviderName = "OPENAI";

export function isRegisteredRealtimeProvider(value: unknown): value is RealtimeProviderName {
  return typeof value === "string"
    && (REGISTERED_REALTIME_PROVIDERS as readonly string[]).includes(value.trim().toUpperCase());
}

export function parseRealtimeProviderName(value: unknown, field = "realtime.provider"): RealtimeProviderName {
  if (typeof value !== "string") throw new Error(`Invalid ${field}`);
  const normalized = value.trim().toUpperCase();
  if (!isRegisteredRealtimeProvider(normalized)) {
    throw new Error(`Unsupported realtime provider: ${normalized || "<empty>"}`);
  }
  return normalized;
}

export function isEnabledRealtimeProvider(value: unknown): value is EnabledRealtimeProviderName {
  return isRegisteredRealtimeProvider(value)
    && (ENABLED_REALTIME_PROVIDERS as readonly string[]).includes(value.trim().toUpperCase());
}

export function requireEnabledRealtimeProvider(provider: RealtimeProviderName): EnabledRealtimeProviderName {
  if (!isEnabledRealtimeProvider(provider)) {
    throw new Error(`Realtime provider is registered but not enabled for traffic: ${provider}`);
  }
  return provider;
}
