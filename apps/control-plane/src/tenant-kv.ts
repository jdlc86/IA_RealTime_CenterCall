export const TENANT_KV_SCHEMA_VERSION = 1 as const;
export const TENANT_KV_PREFIX = "ia-rtcc:v1";

export type TenantStatus = "active" | "disabled";

export type TenantBusinessFacts = Record<string, string | number | boolean>;

export type TenantConfigurationV1 = {
  schemaVersion: 1;
  tenantId: string;
  status: TenantStatus;
  business: {
    displayName: string;
    facts: TenantBusinessFacts;
  };
  assistant: {
    name: string;
    greeting: string;
    language: string;
    /** Canonical tenant-specific behavior/context/limitations prompt stored in KV. */
    systemPrompt?: string;
    /** @deprecated Transitional alias. New tenant payloads must use systemPrompt. */
    instructions?: string;
  };
  realtime: {
    voice?: string;
    vad?: {
      threshold?: number;
      prefixPaddingMs?: number;
      silenceDurationMs?: number;
      idleTimeoutMs?: number;
    };
  };
  tools: {
    allowed: string[];
  };
};

export type TenantRouteV1 = {
  schemaVersion: 1;
  tenantId: string;
  status: TenantStatus;
};

export type TenantResolutionV1 = {
  tenantId: string;
  calledNumber: string;
  source: "called_number";
};

export interface TenantKvNamespace {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid tenant configuration: ${field}`);
  return value.trim();
}

function requireStatus(value: unknown, field: string): TenantStatus {
  if (value !== "active" && value !== "disabled") throw new Error(`Invalid tenant configuration: ${field}`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid tenant configuration: ${field}`);
  const result = value.map((item) => requireNonEmptyString(item, field));
  if (new Set(result).size !== result.length) throw new Error(`Invalid tenant configuration: duplicate ${field}`);
  return result;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid tenant configuration: ${field}`);
  }
  return value as Record<string, unknown>;
}

function parseJsonRecord(raw: string, key: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in tenant KV key ${key}`);
  }
  return requireRecord(parsed, key);
}

export function normalizeCalledNumber(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

export function tenantConfigurationKey(tenantId: string): string {
  return `${TENANT_KV_PREFIX}:tenant:${requireNonEmptyString(tenantId, "tenantId")}`;
}

export function phoneRouteKey(calledNumber: string): string {
  const normalized = normalizeCalledNumber(calledNumber);
  if (!normalized) throw new Error("Invalid tenant route: calledNumber");
  return `${TENANT_KV_PREFIX}:route:phone:${normalized}`;
}

export function parseTenantConfigurationV1(raw: string, expectedTenantId?: string): TenantConfigurationV1 {
  const record = parseJsonRecord(raw, expectedTenantId ? tenantConfigurationKey(expectedTenantId) : "tenant");
  if (record.schemaVersion !== TENANT_KV_SCHEMA_VERSION) {
    throw new Error(`Unsupported tenant configuration schemaVersion: ${String(record.schemaVersion)}`);
  }

  const tenantId = requireNonEmptyString(record.tenantId, "tenantId");
  if (expectedTenantId && tenantId !== expectedTenantId) {
    throw new Error(`Tenant configuration mismatch: expected ${expectedTenantId}, got ${tenantId}`);
  }

  const business = requireRecord(record.business, "business");
  const assistant = requireRecord(record.assistant, "assistant");
  const realtime = requireRecord(record.realtime ?? {}, "realtime");
  const tools = requireRecord(record.tools, "tools");
  const factsRecord = requireRecord(business.facts ?? {}, "business.facts");
  const facts: TenantBusinessFacts = {};
  for (const [key, value] of Object.entries(factsRecord)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Invalid tenant configuration: business.facts.${key}`);
    }
    facts[key] = value;
  }

  let systemPrompt: string | undefined;
  if (assistant.systemPrompt !== undefined) {
    systemPrompt = requireNonEmptyString(assistant.systemPrompt, "assistant.systemPrompt");
  } else if (assistant.instructions !== undefined) {
    // Backward-compatible migration path. New KV payloads should use assistant.systemPrompt.
    systemPrompt = requireNonEmptyString(assistant.instructions, "assistant.instructions");
  }

  let vad: TenantConfigurationV1["realtime"]["vad"];
  if (realtime.vad !== undefined) {
    const vadRecord = requireRecord(realtime.vad, "realtime.vad");
    vad = {};
    for (const [source, target] of [
      ["threshold", "threshold"],
      ["prefixPaddingMs", "prefixPaddingMs"],
      ["silenceDurationMs", "silenceDurationMs"],
      ["idleTimeoutMs", "idleTimeoutMs"],
    ] as const) {
      const value = vadRecord[source];
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`Invalid tenant configuration: realtime.vad.${source}`);
        }
        vad[target] = value;
      }
    }
  }

  return {
    schemaVersion: 1,
    tenantId,
    status: requireStatus(record.status, "status"),
    business: {
      displayName: requireNonEmptyString(business.displayName, "business.displayName"),
      facts,
    },
    assistant: {
      name: requireNonEmptyString(assistant.name, "assistant.name"),
      greeting: requireNonEmptyString(assistant.greeting, "assistant.greeting"),
      language: requireNonEmptyString(assistant.language, "assistant.language"),
      ...(systemPrompt === undefined ? {} : { systemPrompt, instructions: systemPrompt }),
    },
    realtime: {
      ...(realtime.voice === undefined ? {} : { voice: requireNonEmptyString(realtime.voice, "realtime.voice") }),
      ...(vad === undefined ? {} : { vad }),
    },
    tools: {
      allowed: requireStringArray(tools.allowed, "tools.allowed"),
    },
  };
}

export function parseTenantRouteV1(raw: string, key: string): TenantRouteV1 {
  const record = parseJsonRecord(raw, key);
  if (record.schemaVersion !== TENANT_KV_SCHEMA_VERSION) {
    throw new Error(`Unsupported tenant route schemaVersion: ${String(record.schemaVersion)}`);
  }
  return {
    schemaVersion: 1,
    tenantId: requireNonEmptyString(record.tenantId, "tenantId"),
    status: requireStatus(record.status, "status"),
  };
}

export class KvTenantRepository {
  constructor(private readonly kv: TenantKvNamespace, private readonly cacheTtl = 30) {}

  async resolveByCalledNumber(calledNumber: string): Promise<TenantResolutionV1 | null> {
    const normalized = normalizeCalledNumber(calledNumber);
    if (!normalized) return null;
    const key = phoneRouteKey(normalized);
    const raw = await this.kv.get(key, { cacheTtl: this.cacheTtl });
    if (!raw) return null;
    const route = parseTenantRouteV1(raw, key);
    if (route.status !== "active") return null;
    return { tenantId: route.tenantId, calledNumber: normalized, source: "called_number" };
  }

  async getTenantConfiguration(tenantId: string): Promise<TenantConfigurationV1 | null> {
    const key = tenantConfigurationKey(tenantId);
    const raw = await this.kv.get(key, { cacheTtl: this.cacheTtl });
    if (!raw) return null;
    const config = parseTenantConfigurationV1(raw, tenantId);
    return config.status === "active" ? config : null;
  }
}
