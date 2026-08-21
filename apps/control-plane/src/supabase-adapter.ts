export type SupabaseAdapterEnv = {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
};

export type BusinessService = { id: string; code: string | null; name: string; description: string | null; duration_minutes: number | null; price_cents: number | null; currency: string; };
export type BusinessProfessional = { id: string; display_name: string; role_title: string | null; };
export type BusinessHours = { weekday: number; opens_at: string; closes_at: string; };
export type RestaurantMenuItem = { id: string; code: string | null; name: string; description: string | null; category: string | null; price_cents: number | null; currency: string; allergens: string[]; };
export type RestaurantTable = { id: string; code: string; display_name: string; min_capacity: number; max_capacity: number; };
export type RestaurantAvailability = { table_id: string; table_code: string; table_name: string; max_capacity: number; starts_at: string; ends_at: string; };
export type RestaurantReservation = { reservation_code: string; table_id: string; table_code: string; table_name: string; starts_at: string; ends_at: string; status: string; };
export type BookedReservationSummary = { id: string; reservation_code: string; starts_at: string; ends_at: string; party_size: number; customer_name: string; customer_phone: string; status: "BOOKED"; };
export type CreateRestaurantReservationInput = { customerName: string; customerPhone: string; partySize: number; startsAt: string; durationMinutes?: number; notes?: string | null; source?: "voice" | "web" | "manual" | "api"; };
export type MarketingConsentStatus = "PENDING_VERIFICATION" | "VERIFIED" | "DECLINED" | "REVOKED" | "EXPIRED";
export type CallDiagnosticEvent = { call_id: string; tenant_id: string | null; component: string; stage: string; event: string; severity: "info" | "error"; data_requirement?: string | null; tool_name?: string | null; elapsed_ms?: number | null; recovery?: string | null; diagnosis?: string | null; details?: Record<string, unknown>; };

function requireNonEmpty(value: string, name: string): string { if (!value?.trim()) throw new Error(`Missing runtime configuration: ${name}`); return value.trim(); }
function assertTenantId(tenantId: string): string { const value = tenantId.trim(); if (!value || !/^[a-z0-9][a-z0-9-]{1,127}$/.test(value)) throw new Error("Invalid tenant_id"); return value; }
function assertE164(phone: string): string { const value = phone.trim(); if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new Error("Invalid phone number"); return value; }
function assertIsoDateTime(value: string): string { const parsed = Date.parse(value); if (!Number.isFinite(parsed) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) throw new Error("Invalid starts_at"); return new Date(parsed).toISOString(); }

export class SupabaseAdapter {
  private readonly baseUrl: string;
  private readonly secretKey: string;
  constructor(env: SupabaseAdapterEnv) { this.baseUrl = requireNonEmpty(env.SUPABASE_URL, "SUPABASE_URL").replace(/\/+$/, ""); this.secretKey = requireNonEmpty(env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"); }

  private async select<T>(table: string, params: URLSearchParams): Promise<T[]> {
    const response = await fetch(`${this.baseUrl}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`, { method: "GET", headers: { apikey: this.secretKey, Accept: "application/json" } });
    const body = await response.text();
    if (!response.ok) throw new Error(`Supabase ${table} read failed with HTTP ${response.status}`);
    let parsed: unknown; try { parsed = JSON.parse(body); } catch { throw new Error(`Supabase ${table} returned invalid JSON`); }
    if (!Array.isArray(parsed)) throw new Error(`Supabase ${table} returned invalid payload`);
    return parsed as T[];
  }

  async invokeRpc<T>(name: string, body: Record<string, unknown>): Promise<T[]> {
    const response = await fetch(`${this.baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`, { method: "POST", headers: { apikey: this.secretKey, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Supabase RPC ${name} failed with HTTP ${response.status}: ${raw.slice(0, 300)}`);
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error(`Supabase RPC ${name} returned invalid JSON`); }
    if (!Array.isArray(parsed)) throw new Error(`Supabase RPC ${name} returned invalid payload`);
    return parsed as T[];
  }

  private async insertOne<T>(table: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/rest/v1/${encodeURIComponent(table)}`, { method: "POST", headers: { apikey: this.secretKey, "Content-Type": "application/json", Accept: "application/json", Prefer: "return=representation" }, body: JSON.stringify(body) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Supabase ${table} insert failed with HTTP ${response.status}`);
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error(`Supabase ${table} returned invalid JSON`); }
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`Supabase ${table} returned invalid insert payload`);
    return parsed[0] as T;
  }

  private async patch<T>(table: string, params: URLSearchParams, body: Record<string, unknown>): Promise<T[]> {
    const response = await fetch(`${this.baseUrl}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`, { method: "PATCH", headers: { apikey: this.secretKey, "Content-Type": "application/json", Accept: "application/json", Prefer: "return=representation" }, body: JSON.stringify(body) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Supabase ${table} update failed with HTTP ${response.status}`);
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error(`Supabase ${table} returned invalid JSON`); }
    if (!Array.isArray(parsed)) throw new Error(`Supabase ${table} returned invalid update payload`);
    return parsed as T[];
  }

  async writeDiagnosticEvent(event: CallDiagnosticEvent): Promise<void> {
    const response = await fetch(`${this.baseUrl}/rest/v1/call_diagnostic_events`, { method: "POST", headers: { apikey: this.secretKey, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ call_id: event.call_id, tenant_id: event.tenant_id, component: event.component, stage: event.stage, event: event.event, severity: event.severity, data_requirement: event.data_requirement ?? null, tool_name: event.tool_name ?? null, elapsed_ms: event.elapsed_ms ?? null, recovery: event.recovery ?? null, diagnosis: event.diagnosis ?? null, details: event.details ?? {} }) });
    if (!response.ok) throw new Error(`Supabase call_diagnostic_events write failed with HTTP ${response.status}`);
  }

  async listServices(tenantId: string): Promise<BusinessService[]> { const tenant = assertTenantId(tenantId); return this.select<BusinessService>("services", new URLSearchParams({ select: "id,code,name,description,duration_minutes,price_cents,currency", tenant_id: `eq.${tenant}`, active: "eq.true", order: "name.asc", limit: "50" })); }
  async listProfessionals(tenantId: string): Promise<BusinessProfessional[]> { const tenant = assertTenantId(tenantId); return this.select<BusinessProfessional>("professionals", new URLSearchParams({ select: "id,display_name,role_title", tenant_id: `eq.${tenant}`, active: "eq.true", order: "display_name.asc", limit: "50" })); }
  async listBusinessHours(tenantId: string): Promise<BusinessHours[]> { const tenant = assertTenantId(tenantId); return this.select<BusinessHours>("business_hours", new URLSearchParams({ select: "weekday,opens_at,closes_at", tenant_id: `eq.${tenant}`, active: "eq.true", order: "weekday.asc,opens_at.asc", limit: "50" })); }
  async listMenuItems(tenantId: string): Promise<RestaurantMenuItem[]> { const tenant = assertTenantId(tenantId); return this.select<RestaurantMenuItem>("menu_items", new URLSearchParams({ select: "id,code,name,description,category,price_cents,currency,allergens", tenant_id: `eq.${tenant}`, active: "eq.true", order: "category.asc,name.asc", limit: "100" })); }
  async listRestaurantTables(tenantId: string): Promise<RestaurantTable[]> { const tenant = assertTenantId(tenantId); return this.select<RestaurantTable>("restaurant_tables", new URLSearchParams({ select: "id,code,display_name,min_capacity,max_capacity", tenant_id: `eq.${tenant}`, active: "eq.true", order: "max_capacity.asc,code.asc", limit: "100" })); }

  async checkRestaurantAvailability(tenantId: string, startsAt: string, partySize: number, durationMinutes = 90): Promise<RestaurantAvailability[]> {
    const tenant = assertTenantId(tenantId); const start = assertIsoDateTime(startsAt);
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 100) throw new Error("Invalid party_size");
    if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) throw new Error("Invalid duration_minutes");
    return this.invokeRpc<RestaurantAvailability>("check_restaurant_availability", { p_tenant_id: tenant, p_starts_at: start, p_party_size: partySize, p_duration_minutes: durationMinutes });
  }

  async createRestaurantReservation(tenantId: string, input: CreateRestaurantReservationInput): Promise<RestaurantReservation> {
    const tenant = assertTenantId(tenantId); const customerName = requireNonEmpty(input.customerName, "customer_name"); const customerPhone = assertE164(input.customerPhone); const startsAt = assertIsoDateTime(input.startsAt); const durationMinutes = input.durationMinutes ?? 90;
    if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 100) throw new Error("Invalid party_size");
    if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) throw new Error("Invalid duration_minutes");
    const rows = await this.invokeRpc<RestaurantReservation>("create_restaurant_reservation", { p_tenant_id: tenant, p_customer_name: customerName, p_customer_phone: customerPhone, p_party_size: input.partySize, p_starts_at: startsAt, p_duration_minutes: durationMinutes, p_notes: input.notes?.trim() || null, p_source: input.source ?? "voice" });
    if (rows.length !== 1) throw new Error("Reservation creation returned invalid payload");
    return rows[0];
  }

  async listBookedReservationsByPhone(tenantId: string, callerPhone: string, nowIso = new Date().toISOString()): Promise<BookedReservationSummary[]> {
    const tenant = assertTenantId(tenantId); const phone = assertE164(callerPhone); const now = assertIsoDateTime(nowIso);
    return this.select<BookedReservationSummary>("reservations", new URLSearchParams({ select: "id,reservation_code,starts_at,ends_at,party_size,customer_name,customer_phone,status", tenant_id: `eq.${tenant}`, customer_phone: `eq.${phone}`, status: "eq.BOOKED", starts_at: `gte.${now}`, order: "starts_at.asc", limit: "20" }));
  }

  async cancelBookedReservation(tenantId: string, reservationId: string, callerPhone: string): Promise<BookedReservationSummary | null> {
    const tenant = assertTenantId(tenantId); const phone = assertE164(callerPhone); const id = requireNonEmpty(reservationId, "reservation_id");
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error("Invalid reservation_id");
    const rows = await this.patch<BookedReservationSummary>("reservations", new URLSearchParams({ id: `eq.${id}`, tenant_id: `eq.${tenant}`, customer_phone: `eq.${phone}`, status: "eq.BOOKED" }), { status: "CANCELLED", updated_at: new Date().toISOString() });
    if (rows.length > 1) throw new Error("Reservation cancellation matched multiple rows");
    return rows[0] ?? null;
  }

  async createMarketingConsent(tenantId: string, phone: string, accepted: boolean, consentTextVersion: string): Promise<{ id: string; status: MarketingConsentStatus }> {
    const tenant = assertTenantId(tenantId); const normalizedPhone = assertE164(phone); const version = requireNonEmpty(consentTextVersion, "consent_text_version"); const status: MarketingConsentStatus = accepted ? "PENDING_VERIFICATION" : "DECLINED";
    return this.insertOne<{ id: string; status: MarketingConsentStatus }>("marketing_consents", { tenant_id: tenant, phone: normalizedPhone, channel: "sms", status, consent_text_version: version, consented_at: accepted ? new Date().toISOString() : null, source: "voice" });
  }
}
