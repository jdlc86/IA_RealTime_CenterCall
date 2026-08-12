import { CallSession as CallSessionV7 } from "./call-session-v7";
import { decideMarketingPrompt } from "./marketing-consent-prompt-policy";
import { SupabaseMarketingConsentStore } from "./marketing-consent-store";

const MANAGE_MARKETING_CONSENT = "manage_marketing_consent";
const POST_BOOKING_MARKETING_PROMPT = "Después pregunta, de forma separada y opcional, si desea recibir ofertas y promociones en este mismo número.";
const OFFER_POLICY_VERSION = "post-booking-offer-v1";
const SAFE_POST_BOOKING_PROMPT = "Después, de forma separada y opcional, puedes preguntarle si desea recibir ofertas y promociones en este mismo número.";

const BaseConstructor = CallSessionV7 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV7.prototype as any;

function requireRuntimeString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

export class CallSession extends BaseConstructor {
  private getMarketingStoreV8(): SupabaseMarketingConsentStore {
    return new SupabaseMarketingConsentStore({
      SUPABASE_URL: requireRuntimeString((this as any).env?.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireRuntimeString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
  }

  private createSpokenResponse(instructions: string): void {
    if (!instructions.includes(POST_BOOKING_MARKETING_PROMPT)) {
      BasePrototype.createSpokenResponse.call(this, instructions);
      return;
    }
    void this.createPostBookingResponseV8(instructions);
  }

  private async createPostBookingResponseV8(instructions: string): Promise<void> {
    const tenantId = (this as any).tenantId as string | null | undefined;
    const callerPhone = (this as any).callerPhone as string | null | undefined;
    const callId = (this as any).callId as string | null | undefined;
    const marketingEnabled = Array.isArray((this as any).allowedTools) && ((this as any).allowedTools as string[]).includes(MANAGE_MARKETING_CONSENT);

    const suppress = (reason: string, details: Record<string, unknown> = {}): void => {
      (this as any).diagnostics?.checkpoint?.("MARKETING_CONSENT_PROMPT_SUPPRESSED", { reason, ...details });
      BasePrototype.createSpokenResponse.call(
        this,
        instructions.replace(
          POST_BOOKING_MARKETING_PROMPT,
          "No preguntes por promociones en este turno. La reserva ya está confirmada y debe comunicarse con normalidad.",
        ),
      );
    };

    if (!marketingEnabled || !tenantId || !callerPhone || !callId) {
      suppress(!marketingEnabled ? "tool_not_allowed" : !tenantId ? "tenant_unavailable" : !callerPhone ? "caller_phone_unavailable" : "call_id_unavailable");
      return;
    }

    try {
      const store = this.getMarketingStoreV8();
      const latestStatus = await store.getLatestStatus(tenantId, callerPhone);
      const latestOfferAt = latestStatus === null ? await store.getLatestOfferAt(tenantId, callerPhone) : null;
      const decision = decideMarketingPrompt(latestStatus, latestOfferAt);
      if (!decision.ask) {
        suppress(decision.reason.toLowerCase(), {
          status: "status" in decision ? decision.status : null,
          last_offered_at: "lastOfferedAt" in decision ? decision.lastOfferedAt : null,
        });
        return;
      }

      await store.recordOffer(tenantId, {
        phone: callerPhone,
        callId,
        policyVersion: OFFER_POLICY_VERSION,
      });

      (this as any).diagnostics?.checkpoint?.("MARKETING_CONSENT_OFFER_RECORDED", {
        reason: decision.reason,
        policy_version: OFFER_POLICY_VERSION,
      });

      BasePrototype.createSpokenResponse.call(
        this,
        instructions.replace(POST_BOOKING_MARKETING_PROMPT, SAFE_POST_BOOKING_PROMPT),
      );
    } catch (error) {
      (this as any).diagnostics?.fail?.("MARKETING_CONSENT_OFFER_GATE_FAILED", "MARKETING_OFFER_HISTORY_UNAVAILABLE", {
        error: error instanceof Error ? error.message : String(error),
      });
      suppress("offer_history_failed");
    }
  }
}
