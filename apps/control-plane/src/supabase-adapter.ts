export type SupabaseAdapterEnv = {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
};

export type BusinessService = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  duration_minutes: number | null;
  price_cents: number | null;
  currency: string;
};

export type BusinessProfessional = {
  id: string;
  display_name: string;
  role_title: string | null;
};

export type BusinessHours = {
  weekday: number;
  opens_at: string;
  closes_at: string;
};

function requireNonEmpty(value: string, name: string): string {
  if (!value?.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function assertTenantId(tenantId: string): string {
  const value = tenantId.trim();
  if (!value || !/^[a-z0-9][a-z0-9-]{1,127}$/.test(value)) {
    throw new Error("Invalid tenant_id");
  }
  return value;
}

export class SupabaseAdapter {
  private readonly baseUrl: string;
  private readonly secretKey: string;

  constructor(env: SupabaseAdapterEnv) {
    this.baseUrl = requireNonEmpty(env.SUPABASE_URL, "SUPABASE_URL").replace(/\/+$/, "");
    this.secretKey = requireNonEmpty(env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
  }

  private async select<T>(table: string, params: URLSearchParams): Promise<T[]> {
    const url = `${this.baseUrl}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: this.secretKey,
        Accept: "application/json",
      },
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase ${table} read failed with HTTP ${response.status}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`Supabase ${table} returned invalid JSON`);
    }
    if (!Array.isArray(parsed)) throw new Error(`Supabase ${table} returned invalid payload`);
    return parsed as T[];
  }

  async listServices(tenantId: string): Promise<BusinessService[]> {
    const tenant = assertTenantId(tenantId);
    const params = new URLSearchParams({
      select: "id,code,name,description,duration_minutes,price_cents,currency",
      tenant_id: `eq.${tenant}`,
      active: "eq.true",
      order: "name.asc",
      limit: "50",
    });
    return this.select<BusinessService>("services", params);
  }

  async listProfessionals(tenantId: string): Promise<BusinessProfessional[]> {
    const tenant = assertTenantId(tenantId);
    const params = new URLSearchParams({
      select: "id,display_name,role_title",
      tenant_id: `eq.${tenant}`,
      active: "eq.true",
      order: "display_name.asc",
      limit: "50",
    });
    return this.select<BusinessProfessional>("professionals", params);
  }

  async listBusinessHours(tenantId: string): Promise<BusinessHours[]> {
    const tenant = assertTenantId(tenantId);
    const params = new URLSearchParams({
      select: "weekday,opens_at,closes_at",
      tenant_id: `eq.${tenant}`,
      active: "eq.true",
      order: "weekday.asc,opens_at.asc",
      limit: "50",
    });
    return this.select<BusinessHours>("business_hours", params);
  }
}
