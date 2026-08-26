export const TENANT_ROUTE_SCHEMA_VERSION = 1 as const;
export const TENANT_ROUTE_PREFIX = "ia-rtcc:v1";

export type GeminiTenantRoute = Readonly<{
  tenantId: string;
  calledNumber: string;
  source: "called_number";
}>;

export interface TenantRouteKvNamespace {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
}

export interface GeminiTenantRoutePort {
  resolveByCalledNumber(calledNumber: string): Promise<GeminiTenantRoute | null>;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > 256 || /[\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

export function normalizeCalledNumber(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

export function tenantPhoneRouteKey(calledNumber: string): string {
  const normalized = normalizeCalledNumber(calledNumber);
  if (!normalized) throw new Error("calledNumber is invalid");
  return `${TENANT_ROUTE_PREFIX}:route:phone:${normalized}`;
}

function parseRoute(raw: string, key: string): Readonly<{ tenantId: string; status: "active" | "disabled" }> {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`Invalid JSON in tenant route ${key}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid tenant route ${key}`);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== TENANT_ROUTE_SCHEMA_VERSION) throw new Error(`Unsupported tenant route schemaVersion in ${key}`);
  const status = record.status;
  if (status !== "active" && status !== "disabled") throw new Error(`Invalid tenant route status in ${key}`);
  return Object.freeze({ tenantId: required(record.tenantId, "tenant route tenantId"), status });
}

/**
 * Minimal adapter over the shared tenant phone-route KV. It intentionally does
 * not import provider selection, assistant config or any OpenAI runtime code.
 */
export class KvGeminiTenantRoutePort implements GeminiTenantRoutePort {
  constructor(
    private readonly kv: TenantRouteKvNamespace,
    private readonly cacheTtlSeconds = 30,
  ) {
    if (!Number.isSafeInteger(cacheTtlSeconds) || cacheTtlSeconds < 0) throw new Error("tenant route cache TTL is invalid");
  }

  async resolveByCalledNumber(calledNumber: string): Promise<GeminiTenantRoute | null> {
    const normalized = normalizeCalledNumber(calledNumber);
    if (!normalized) return null;
    const key = tenantPhoneRouteKey(normalized);
    const raw = await this.kv.get(key, { cacheTtl: this.cacheTtlSeconds });
    if (!raw) return null;
    const route = parseRoute(raw, key);
    if (route.status !== "active") return null;
    return Object.freeze({ tenantId: route.tenantId, calledNumber: normalized, source: "called_number" });
  }
}
