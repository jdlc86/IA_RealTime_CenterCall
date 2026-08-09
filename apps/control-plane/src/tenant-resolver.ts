export type TenantId = string;

export type TenantRoutingContext = {
  calledNumber: string;
};

export type TenantResolution = {
  tenantId: TenantId;
  calledNumber: string;
  source: "called_number";
};

export interface TenantResolver {
  resolve(context: TenantRoutingContext): TenantResolution | null;
}

export type TenantRoute = {
  calledNumber: string;
  tenantId: TenantId;
};

function normalizeCalledNumber(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  // Keep E.164 semantics while tolerating presentation characters from providers.
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

function assertTenantId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid tenant route: tenantId must be a non-empty string");
  }
}

export class StaticTenantResolver implements TenantResolver {
  private readonly routes: Map<string, TenantId>;

  constructor(routes: TenantRoute[]) {
    this.routes = new Map();

    for (const route of routes) {
      const calledNumber = normalizeCalledNumber(route.calledNumber);
      assertTenantId(route.tenantId);
      if (!calledNumber) throw new Error("Invalid tenant route: calledNumber is required");
      if (this.routes.has(calledNumber)) {
        throw new Error(`Duplicate tenant route for called number ${calledNumber}`);
      }
      this.routes.set(calledNumber, route.tenantId.trim());
    }
  }

  resolve(context: TenantRoutingContext): TenantResolution | null {
    const calledNumber = normalizeCalledNumber(context.calledNumber);
    if (!calledNumber) return null;

    const tenantId = this.routes.get(calledNumber);
    if (!tenantId) return null;

    return {
      tenantId,
      calledNumber,
      source: "called_number",
    };
  }
}

export function parseTenantRoutesJson(value: string): TenantRoute[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("TENANT_ROUTES_JSON must contain valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("TENANT_ROUTES_JSON must be a JSON array");
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Invalid tenant route at index ${index}`);
    }

    const record = item as Record<string, unknown>;
    if (typeof record.called_number !== "string" || !record.called_number.trim()) {
      throw new Error(`Invalid tenant route at index ${index}: called_number is required`);
    }
    assertTenantId(record.tenant_id);

    return {
      calledNumber: record.called_number,
      tenantId: record.tenant_id,
    };
  });
}
