export type SupabaseServicesEnv = {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
};

export type VerifiedService = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  duration_minutes: number | null;
  price_cents: number | null;
  currency: string;
};

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function assertTenantId(tenantId: string): string {
  const value = tenantId.trim();
  if (!value || !/^[a-z0-9][a-z0-9-]{1,127}$/.test(value)) throw new Error("Invalid tenant_id");
  return value;
}

export class SupabaseServicesReader {
  private readonly baseUrl: string;
  private readonly secretKey: string;

  constructor(env: SupabaseServicesEnv) {
    this.baseUrl = requireNonEmpty(env.SUPABASE_URL, "SUPABASE_URL").replace(/\/+$/, "");
    this.secretKey = requireNonEmpty(env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
  }

  async listServices(tenantId: string): Promise<VerifiedService[]> {
    const tenant = assertTenantId(tenantId);
    const params = new URLSearchParams({
      select: "id,code,name,description,duration_minutes,price_cents,currency",
      tenant_id: `eq.${tenant}`,
      active: "eq.true",
      order: "name.asc",
      limit: "50",
    });
    const url = `${this.baseUrl}/rest/v1/services?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: this.secretKey,
        Authorization: `Bearer ${this.secretKey}`,
        Accept: "application/json",
      },
    });

    const body = await response.text();
    if (!response.ok) throw new Error(`Supabase services read failed with HTTP ${response.status}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("Supabase services returned invalid JSON");
    }
    if (!Array.isArray(parsed)) throw new Error("Supabase services returned invalid payload");
    return parsed as VerifiedService[];
  }
}
