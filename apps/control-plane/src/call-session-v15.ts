import { CallSession as CallSessionV14 } from "./call-session-v14";
import { applyPostBookingConversationPolicy } from "./post-booking-conversation-policy";

const BaseConstructor = CallSessionV14 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV14.prototype as any;

/**
 * v15 applies one deterministic post-result conversation rule:
 * after BOOKED or a marketing-consent result, Lucía must immediately offer to
 * handle another need instead of leaving the call open in silence. Deferred
 * promises about offers/promotions are explicitly forbidden.
 */
export class CallSession extends BaseConstructor {
  private createSpokenResponse(instructions: string): void {
    const governed = applyPostBookingConversationPolicy(instructions);
    if (governed !== instructions) {
      (this as any).diagnostics?.checkpoint?.("POST_BOOKING_PROACTIVE_PROMPT_APPLIED", {
        proactive_next_intent: true,
        deferred_marketing_language_forbidden: true,
      });
    }
    BasePrototype.createSpokenResponse.call(this, governed);
  }
}
