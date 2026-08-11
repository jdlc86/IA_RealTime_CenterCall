import { isBusinessType, type BusinessType } from "./business-types.js";

export const TENANT_KV_SCHEMA_VERSION = 1 as const;
export const TENANT_KV_SCHEMA_VERSION_V2 = 2 as const;
export const TENANT_KV_PREFIX = "ia-rtcc:v1";
export const TENANT_KV_PREFIX_V2 = "ia-rtcc:v2";

export type TenantStatus = "active" | "disabled";
export type TenantBusinessFacts = Record<string, string | number | boolean>;

type TenantConfigurationCommon = {
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
    systemPrompt?: string;
    waitingPhrases?: string[];
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

export type LegacyTenantConfigurationV1 = TenantConfigurationCommon & {
  schemaVersion: 1;
};

export type TenantConfigurationV2 = TenantConfigurationCommon & {
  schemaVersion: 2;
  businessType: BusinessType;
  verticalConfig: Record<string, unknown>;
};

export type TenantConfiguration = LegacyTenantConfigurationV1 | TenantConfigurationV2;

/**
 * @deprecated Compatibility alias for existing runtime consumers during the V1→V2 migration.
 * New code should use TenantConfiguration or the explicit LegacyTenantConfigurationV1/TenantConfigurationV2 types.
 */
export type TenantConfigurationV1 = TenantConfiguration;

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

function requireBusinessType(value: unknown, field: string): BusinessType {
  if (!isBusinessType(value)) throw new Error(`Invalid tenant configuration: ${field}`);
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

export function tenantConfigurationKeyV2(tenantId: string): string {
  return `${TENANT_KV_PREFIX_V2}:tenant:${requireNonEmptyString(tenantId, "tenantId")}`;
}

export function phoneRouteKey(calledNumber: string): string {
  const normalized = normalizeCalledNumber(calledNumber);
  if (!normalized) throw new Error("Invalid tenant route: calledNumber");
  return `${TENANT_KV_PREFIX}:route:phone:${normalized}`;
}

function parseCommon(record: Record<string, unknown>, expectedTenantId?: string): TenantConfigurationCommon {
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
    systemPrompt = requireNonEmptyString(assistant.instructions, "assistant.instructions");
  }

  let waitingPhrases: string[] | undefined;
  if (assistant.waitingPhrases !== undefined) {
    waitingPhrases = requireStringArray(assistant.waitingPhrases, "assistant.waitingPhrases");
    if (waitingPhrases.length === 0) throw new Error("Invalid tenant configuration: assistant.waitingPhrases must not be empty");
    if (waitingPhrases.length > 10) throw new Error("Invalid tenant configuration: assistant.waitingPhrases supports at most 10 phrases");
  }

  let vad: TenantConfigurationCommon["realtime"]["vad"];
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
      ...(waitingPhrases === undefined ? {} : { waitingPhrases }),
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

export function parseTenantConfigurationV1(raw: string, expectedTenantId?: string): LegacyTenantConfigurationV1 {
  const record = parseJsonRecord(raw, expectedTenantId ? tenantConfigurationKey(expectedTenantId) : "tenant");
  if (record.schemaVersion !== TENANT_KV_SCHEMA_VERSION) {
    throw new Error(`Unsupported tenant configuration schemaVersion: ${String(record.schemaVersion)}`);
  }
  return { schemaVersion: 1, ...parseCommon(record, expectedTenantId) };
}

export function parseTenantConfigurationV2(raw: string, expectedTenantId?: string): TenantConfigurationV2 {
  const record = parseJsonRecord(raw, expectedTenantId ? tenantConfigurationKeyV2(expectedTenantId) : "tenant-v2");
  if (record.schemaVersion !== TENANT_KV_SCHEMA_VERSION_V2) {
    throw new Error(`Unsupported tenant configuration schemaVersion: ${String(record.schemaVersion)}`);
  }
  const verticalConfig = requireRecord(record.verticalConfig, "verticalConfig");
  return {
    schemaVersion: 2,
    ...parseCommon(record, expectedTenantId),
    businessType: requireBusinessType(record.businessType, "businessType"),
    verticalConfig,
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

  async getTenantConfiguration(tenantId: string): Promise<TenantConfiguration | null> {
    const v2Key = tenantConfigurationKeyV2(tenantId);
    const v2Raw = await this.kv.get(v2Key, { cacheTtl: this.cacheTtl });
    if (v2Raw) {
      const config = parseTenantConfigurationV2(v2Raw, tenantId);
      return config.status === "active" ? config : null;
    }

    const v1Key = tenantConfigurationKey(tenantId);
    const v1Raw = await this.kv.get(v1Key, { cacheTtl: this.cacheTtl });
    if (!v1Raw) return null;
    const config = parseTenantConfigurationV1(v1Raw, tenantId);
    return config.status === "active" ? config : null;
  }
}
