import { CallSession as CallSessionV50 } from "./call-session-v50-reservation-date-scope";
import { shouldConsumeSemanticToolDecision } from "./semantic-turn-decision-policy";

const BaseConstructor = CallSessionV50 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV50.prototype as any;

type RealtimeToolEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

/**
 * V51 closes a liveness hole between V29 semantic uniqueness and V25/V31
 * argument validation.
 *
 * An unparseable function-call payload cannot execute any business action, so
 * it must not consume V29's one-authoritative-tool slot. The malformed attempt
 * is allowed to continue downward only so the existing validation boundary can
 * return INVALID_ARGUMENTS. A later syntactically valid tool call in the same
 * caller turn is then evaluated by V29 normally and becomes the sole
 * authoritative decision. No retry timer, second classifier, or mutation retry
 * is introduced here.
 */
export class CallSession extends BaseConstructor {
  protected authorizePublicRestaurantToolV29(event: RealtimeToolEvent): boolean {
    if (!shouldConsumeSemanticToolDecision(event.arguments)) {
      (this as any).diagnostics?.checkpoint?.("SEMANTIC_TOOL_INVALID_ARGUMENTS_NOT_CONSUMED_V51", {
        tool: event.name ?? null,
        call_id: event.call_id ?? null,
        semantic_decision_consumed: false,
        business_action_executed: false,
        lower_argument_validation_preserved: true,
      });
      return true;
    }

    return BasePrototype.authorizePublicRestaurantToolV29.call(this, event);
  }
}
