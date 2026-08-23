import { TENANT_KV_PREFIX, type TenantConfiguration, type TenantKvNamespace } from "./tenant-kv.js";
import {
  DEFAULT_REALTIME_PROVIDER,
  ENABLED_REALTIME_PROVIDERS,
  REGISTERED_REALTIME_PROVIDERS,
  isEnabledRealtimeProvider,
  isRegisteredRealtimeProvider,
  parseRealtimeProviderName,
  requireEnabledRealtimeProvider,
  type EnabledRealtimeProviderName,
  type RealtimeProviderName,
} from "./realtime-provider-types.js";

export {
  DEFAULT_REALTIME_PROVIDER,
  ENABLED_REALTIME_PROVIDERS,
  REGISTERED_REALTIME_PROVIDERS,
  isEnabledRealtimeProvider,
  isRegisteredRealtimeProvider,
  parseRealtimeProviderName,
  requireEnabledRealtimeProvider,
  type EnabledRealtimeProviderName,
  type RealtimeProviderName,
};

export type RealtimeProviderSelectionSource = "DEFAULT" | "TENANT_CONFIG" | "KV_OVERRIDE";
export type RealtimeProviderSelection = {
  tenantId: string;
  provider: RealtimeProviderName;
  source: RealtimeProviderSelectionSource;
  overrideKey: string;
};

export function realtimeProviderOverrideKey(tenantId: string): string {
  const normalized = tenantId.trim();
  if (!normalized) throw new Error("Invalid realtime provider selection: tenantId");
  return `${TENANT_KV_PREFIX}:runtime:realtime-provider:${normalized}`;
}

function parseRequestedProvider(value: unknown, tenantId: string): RealtimeProviderName {
  try {
    return parseRealtimeProviderName(value, "realtime provider");
  } catch {
    const normalized = typeof value === "string" ? value.trim().toUpperCase() : String(value);
    throw new Error(`Unsupported realtime provider for tenant ${tenantId}: ${normalized || "<empty>"}`);
  }
}

/**
 * Single provider-selection authority for a resolved tenant.
 *
 * Precedence is operational KV override > tenant configuration > OPENAI default.
 * The selector may resolve a registered provider that is not yet traffic-enabled;
 * the composition/runtime boundary is responsible for failing closed before a call
 * can enter an unavailable provider implementation.
 */
export async function selectRealtimeProvider(
  tenantConfiguration: TenantConfiguration,
  kv?: TenantKvNamespace | null,
  cacheTtl = 30,
): Promise<RealtimeProviderSelection> {
  const tenantId = tenantConfiguration.tenantId.trim();
  const overrideKey = realtimeProviderOverrideKey(tenantId);
  const rawOverride = kv ? await kv.get(overrideKey, { cacheTtl }) : null;

  if (typeof rawOverride === "string" && rawOverride.trim()) {
    return {
      tenantId,
      provider: parseRequestedProvider(rawOverride, tenantId),
      source: "KV_OVERRIDE",
      overrideKey,
    };
  }

  if (tenantConfiguration.realtime.provider) {
    return {
      tenantId,
      provider: parseRequestedProvider(tenantConfiguration.realtime.provider, tenantId),
      source: "TENANT_CONFIG",
      overrideKey,
    };
  }

  return {
    tenantId,
    provider: DEFAULT_REALTIME_PROVIDER,
    source: "DEFAULT",
    overrideKey,
  };
}
