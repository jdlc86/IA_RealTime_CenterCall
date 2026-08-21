import {
  SupabaseMarketingConsentStore,
  type MarketingConsentEvent,
  type MarketingConsentStatus,
  type RecordMarketingConsentInput,
  type RecordMarketingOfferInput,
} from "./marketing-consent-store.js";

export type MarketingConsentPort = Readonly<{
  getLatestStatus(tenantId: string, phone: string): Promise<MarketingConsentStatus | null>;
  getLatestOfferAt(tenantId: string, phone: string): Promise<string | null>;
  recordOffer(tenantId: string, input: RecordMarketingOfferInput): Promise<void>;
  record(tenantId: string, input: RecordMarketingConsentInput): Promise<MarketingConsentEvent>;
}>;

type MarketingConsentHost = object & {
  env?: Record<string, unknown>;
};

function requiredConfig(host: MarketingConsentHost, name: "SUPABASE_URL" | "SUPABASE_SECRET_KEY"): string {
  const value = host.env?.[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

const ports = new WeakMap<object, MarketingConsentPort>();

/**
 * Provider-neutral composition boundary for marketing consent persistence.
 * Consent policy and conversational state remain with their existing owners;
 * this port only exposes persistence capabilities and wires the provider edge.
 */
export function marketingConsentPortFor(host: MarketingConsentHost): MarketingConsentPort {
  let port = ports.get(host);
  if (!port) {
    port = new SupabaseMarketingConsentStore({
      SUPABASE_URL: requiredConfig(host, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requiredConfig(host, "SUPABASE_SECRET_KEY"),
    });
    ports.set(host, port);
  }
  return port;
}
