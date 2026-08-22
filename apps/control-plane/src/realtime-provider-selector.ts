import { TENANT_KV_PREFIX, type TenantConfiguration, type TenantKvNamespace } from "./tenant-kv.js";

export const REGISTERED_REALTIME_PROVIDERS = ["OPENAI"] as const;
export type RealtimeProviderName = (typeof REGISTERED_REALTIME_PROVIDERS)[number];
export const DEFAULT_REALTIME_PROVIDER: RealtimeProviderName = "OPENAI";

export type RealtimeProviderSelectionSource = "DEFAULT" | "KV_OVERRIDE";
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

export function isRegisteredRealtimeProvider(value: unknown): value is RealtimeProviderName {
  return typeof value === "string"
    && (REGISTERED_REALTIME_PROVIDERS as readonly string[]).includes(value.trim().toUpperCase());
}

function parseRequestedProvider(value: string, tenantId: string): RealtimeProviderName {
  const normalized = value.trim().toUpperCase();
  if (!isRegisteredRealtimeProvider(normalized)) {
    throw new Error(`Unsupported realtime provider for tenant ${tenantId}: ${normalized || "<empty>"}`);
  }
  return normalized;
}

/**
 * Single provider-selection authority for a resolved tenant.
 *
 * Gate A deliberately keeps OPENAI as the only registered provider. The tenant
 * configuration establishes the resolved tenant identity; an optional operational
 * KV override may select a registered provider without leaking provider branches
 * into CallSession. Unknown providers fail closed here.
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

  return {
    tenantId,
    provider: DEFAULT_REALTIME_PROVIDER,
    source: "DEFAULT",
    overrideKey,
  };
}
