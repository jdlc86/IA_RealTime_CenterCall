import { requireRealtimeProviderTrafficReadiness } from "./realtime-provider-capabilities.js";
import type { RealtimeProviderSelection } from "./realtime-provider-selector.js";
import { requireEnabledRealtimeProvider, type RealtimeProviderName } from "./realtime-provider-types.js";

export type RealtimeProviderTrafficEnvironment = "production" | "preview" | "dev";

export type RealtimeProviderTrafficPolicy = Readonly<{
  environment: unknown;
  geminiEnabled?: unknown;
  geminiCanaryTenantId?: unknown;
}>;

export type RealtimeProviderTrafficAdmission = Readonly<{
  provider: RealtimeProviderName;
  tenantId: string;
  selectionSource: RealtimeProviderSelection["source"];
  environment: RealtimeProviderTrafficEnvironment;
  scope: "BASELINE" | "SINGLE_TENANT_CANARY";
}>;

class IssuedRealtimeProviderTrafficAdmission implements RealtimeProviderTrafficAdmission {
  constructor(
    readonly provider: RealtimeProviderName,
    readonly tenantId: string,
    readonly selectionSource: RealtimeProviderSelection["source"],
    readonly environment: RealtimeProviderTrafficEnvironment,
    readonly scope: RealtimeProviderTrafficAdmission["scope"],
  ) {}
}

function environment(value: unknown): RealtimeProviderTrafficEnvironment {
  if (typeof value !== "string") throw new Error("Realtime provider traffic environment is invalid");
  const normalized = value.trim().toLowerCase();
  if (normalized !== "production" && normalized !== "preview" && normalized !== "dev") {
    throw new Error(`Realtime provider traffic environment is invalid: ${normalized || "<empty>"}`);
  }
  return normalized;
}

function requiredTenantId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function explicitlyEnabled(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function issueAdmission(
  selection: RealtimeProviderSelection,
  admittedEnvironment: RealtimeProviderTrafficEnvironment,
  scope: RealtimeProviderTrafficAdmission["scope"],
): RealtimeProviderTrafficAdmission {
  return Object.freeze(new IssuedRealtimeProviderTrafficAdmission(
    selection.provider,
    requiredTenantId(selection.tenantId, "Realtime provider traffic tenant_id"),
    selection.source,
    admittedEnvironment,
    scope,
  ));
}

/**
 * Mints an in-process, non-serializable traffic grant for one immutable provider
 * selection. OpenAI retains the globally enabled baseline. Gemini additionally
 * requires an explicit enable flag and an exact single-tenant match. Dev remains
 * disabled. Production can mint only the same narrow canary grant, never a
 * global Gemini grant.
 */
export function authorizeRealtimeProviderTraffic(
  selection: RealtimeProviderSelection,
  policy: RealtimeProviderTrafficPolicy,
): RealtimeProviderTrafficAdmission {
  const admittedEnvironment = environment(policy.environment);
  requireRealtimeProviderTrafficReadiness(selection.provider);

  if (selection.provider === "OPENAI") {
    requireEnabledRealtimeProvider(selection.provider);
    return issueAdmission(selection, admittedEnvironment, "BASELINE");
  }

  if (admittedEnvironment === "dev") {
    throw new Error("GEMINI traffic is disabled in dev");
  }
  if (!explicitlyEnabled(policy.geminiEnabled)) {
    throw new Error(`GEMINI traffic requires explicit ${admittedEnvironment} enablement`);
  }

  const canaryTenantId = requiredTenantId(
    policy.geminiCanaryTenantId,
    "GEMINI canary tenant_id",
  );
  const selectedTenantId = requiredTenantId(selection.tenantId, "Realtime provider traffic tenant_id");
  if (selectedTenantId !== canaryTenantId) {
    throw new Error(`GEMINI traffic is not enabled for tenant: ${selectedTenantId}`);
  }

  return issueAdmission(selection, admittedEnvironment, "SINGLE_TENANT_CANARY");
}

/** Rejects fabricated, stale-for-another-selection or cross-tenant grants. */
export function requireRealtimeProviderTrafficAdmission(
  selection: RealtimeProviderSelection,
  admission: RealtimeProviderTrafficAdmission,
): RealtimeProviderTrafficAdmission {
  if (
    !admission
    || !(admission instanceof IssuedRealtimeProviderTrafficAdmission)
  ) {
    throw new Error("Realtime provider traffic admission was not issued by the admission authority");
  }
  if (
    admission.provider !== selection.provider
    || admission.tenantId !== selection.tenantId
    || admission.selectionSource !== selection.source
  ) {
    throw new Error("Realtime provider traffic admission does not match immutable selection");
  }
  return admission;
}
