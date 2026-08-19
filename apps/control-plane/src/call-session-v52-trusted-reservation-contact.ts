import { CallSession as CallSessionV51 } from "./call-session-v51-malformed-tool-authority";
import { rewriteReservationCreateContactEvent } from "./reservation-contact-identity.js";

const BaseConstructor = CallSessionV51 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV51.prototype as any;

/**
 * V52 makes the trusted SIP/Telnyx caller identity authoritative for the
 * reservation contact unless the tool explicitly carries an internationally
 * unambiguous alternate contact. It does not interpret language and does not
 * change V29/V36/V40/V51 ownership semantics.
 */
export class CallSession extends BaseConstructor {
  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const callerPhone = typeof (this as any).callerPhone === "string" ? (this as any).callerPhone.trim() : "";
    if (!callerPhone) {
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    let rewritten: ReturnType<typeof rewriteReservationCreateContactEvent>;
    try {
      rewritten = rewriteReservationCreateContactEvent(data, callerPhone);
    } catch (error) {
      (this as any).diagnostics?.fail?.(
        "RESERVATION_CONTACT_IDENTITY_REJECTED_V52",
        "RESERVATION_CONTACT_IDENTITY_INVALID",
        { error: error instanceof Error ? error.message : String(error) },
      );
      await BasePrototype.handleRealtimeMessage.call(this, data);
      return;
    }

    if (rewritten.changed) {
      (this as any).diagnostics?.checkpoint?.("RESERVATION_CONTACT_IDENTITY_CANONICALIZED_V52", {
        source: rewritten.source,
        trusted_caller_authoritative: rewritten.source === "TRUSTED_CALLER",
        globally_unambiguous_e164: true,
      });
    }

    await BasePrototype.handleRealtimeMessage.call(this, rewritten.data);
  }
}
