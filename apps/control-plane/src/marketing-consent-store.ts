import { normalizeE164, type MarketingConsentAction } from "./marketing-consent-flow.js";

export type MarketingConsentStoreEnv = {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
};

export type MarketingConsentEvent = {
  id: string;
  status: "VERIFIED" | "DECLINED" | "REVOKED";
};

export type RecordMarketingConsentInput = {
  action: MarketingConsentAction;
  phone: string;
  callerPhone: string;
  callId: string;
  consentTextVersion: string;
  verificationMethod: "CALLER_ID_MATCH";
};

function requireNonEmpty(value: string, name: string): string {
  if (!value?.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function assertTenantId(tenantId: string): string {
  const value = tenantId.trim();
  if (!value || !/^[a-z0-9][a-z0-9-]{1,127}$/.test(value)) throw new Error("Invalid tenant_id");
  return value;
}

export class SupabaseMarketingConsentStore {
  private readonly baseUrl: string;
  private readonly secretKey: string;

  constructor(env: MarketingConsentStoreEnv) {
    this.baseUrl = requireNonEmpty(env.SUPABASE_URL, "SUPABASE_URL").replace(/\/+$/, "");
    this.secretKey = requireNonEmpty(env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
  }

  async record(tenantId: string, input: RecordMarketingConsentInput): Promise<MarketingConsentEvent> {
    const tenant = assertTenantId(tenantId);
    const phone = normalizeE164(input.phone);
    const callerPhone = normalizeE164(input.callerPhone);
    const callId = requireNonEmpty(input.callId, "call_id");
    const version = requireNonEmpty(input.consentTextVersion, "consent_text_version");

    if (input.verificationMethod === "CALLER_ID_MATCH" && callerPhone !== phone) {
      throw new Error("CALLER_ID_MATCH requires caller phone to equal marketing phone");
    }

    const now = new Date().toISOString();
    const status = input.action === "GRANT" ? "VERIFIED" : input.action === "DECLINE" ? "DECLINED" : "REVOKED";

    const response = await fetch(`${this.baseUrl}/rest/v1/marketing_consents`, {
      method: "POST",
      headers: {
        apikey: this.secretKey,
        "Content-Type": "application/json",
        Accept: "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        tenant_id: tenant,
        phone,
        channel: "phone",
        status,
        consent_text_version: version,
        consented_at: input.action === "GRANT" ? now : null,
        verified_at: input.action === "GRANT" ? now : null,
        revoked_at: input.action === "REVOKE" ? now : null,
        source: "voice",
        verification_method: input.verificationMethod,
        caller_phone: callerPhone,
        call_id: callId,
      }),
    });

    const raw = await response.text();
    if (!response.ok) throw new Error(`Supabase marketing_consents insert failed with HTTP ${response.status}`);

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("Supabase marketing_consents returned invalid JSON"); }
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("Supabase marketing_consents returned invalid insert payload");
    return parsed[0] as MarketingConsentEvent;
  }
}
