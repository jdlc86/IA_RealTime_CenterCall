import { CallSession as CallSessionV8 } from "./call-session-v8";
import { authorizeSpecializedFlow } from "./conversation-state-authority";
import { parseSemanticDecision } from "./semantic-router";
import {
  executeLegacyIntent,
  LEGACY_INTENT_EXECUTOR,
  type LegacyIntentSelection,
} from "./legacy-intent-execution.js";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { reservationRoutingRuntimeFor } from "./reservation-routing-runtime.js";

const CONVERSATION_INTENT = "conversation_intent";
const BaseConstructor = CallSessionV8 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV8.prototype as any;

function hasReservationDraft(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function rawReservationOperation(argumentsJson: string | undefined): "CREATE" | "QUERY" | "CANCEL" | null {
  if (!argumentsJson?.trim()) return null;
  try {
    const root = JSON.parse(argumentsJson) as Record<string, unknown>;
    const reservation = root.reservation;
    if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) return null;
    const operation = (reservation as Record<string, unknown>).operation;
    if (operation === "QUERY" || operation === "CANCEL" || operation === "CREATE") return operation;
    return "CREATE";
  } catch {
    return null;
  }
}

/**
 * v9 is the session-boundary authority. Older workflow layers may implement how a
 * reservation or marketing action runs, but they no longer get to bypass call
 * lifecycle ownership. This keeps the validated workflow implementations intact
 * while making routing precedence explicit in one place.
 */
export class CallSession extends BaseConstructor {
  async [LEGACY_INTENT_EXECUTOR](selection: LegacyIntentSelection): Promise<void> {
    const routing = reservationRoutingRuntimeFor(this);
    const semantic = parseSemanticDecision(selection.argumentsJson);
    const operation = semantic.dataRequirement === "RESERVATION" ? rawReservationOperation(selection.argumentsJson) : null;
    if (semantic.intent === "CONTINUE" && semantic.dataRequirement === "RESERVATION" && operation !== "QUERY" && operation !== "CANCEL") {
      routing.markCreateIntentActive();
    }
    if ((this as any).reservationBookedThisCall === true || operation === "QUERY" || operation === "CANCEL") {
      routing.clearCreateIntent();
    }

    const routingState = routing.snapshot();
    const reservationInProgress = (routingState.createIntentActive || hasReservationDraft((this as any).reservationDraft))
      && (this as any).reservationBookedThisCall !== true;
    const terminal = conversationLifecyclePortFor(this).isTerminal();
    const authority = authorizeSpecializedFlow({
      lifecycleState: terminal ? "closing" : "active",
      hangupStarted: false,
      reservationInProgress,
    }, semantic);

    (this as any).diagnostics?.checkpoint?.("CONVERSATION_STATE_AUTHORITY", {
      lifecycle_state: terminal ? "closing" : "active",
      reservation_in_progress: reservationInProgress,
      reservation_intent_active: routingState.createIntentActive,
      classifier_requirement: semantic.dataRequirement,
      classifier_degraded: semantic.degraded,
      authorized_flow: authority.flow,
      authority_reason: authority.reason,
    });

    if (authority.reason === "CALL_TERMINAL") {
      if (selection.callId) {
        realtimeCommandPortFor(this as any).submitToolResult({
          callId: selection.callId,
          toolName: CONVERSATION_INTENT,
          output: { ok: true, action: "closing_already_in_progress" },
        });
      }
      return;
    }

    if (authority.flow === "RESERVATION" && semantic.dataRequirement !== "RESERVATION") {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(selection.argumentsJson ?? "{}") as Record<string, unknown>; } catch { parsed = {}; }
      (this as any).diagnostics?.checkpoint?.("RESERVATION_ROUTING_RECOVERED_BY_STATE", {
        from_requirement: semantic.dataRequirement,
        reason: authority.reason,
      });
      await executeLegacyIntent(BasePrototype, this, {
        ...selection,
        argumentsJson: JSON.stringify({ ...parsed, intent: "CONTINUE", data_requirement: "RESERVATION" }),
      });
      return;
    }

    await executeLegacyIntent(BasePrototype, this, selection);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = adaptRealtimeProviderEvents(data).find(
      (candidate) => candidate.type === "SEMANTIC_TOOL_SELECTED" && candidate.name === CONVERSATION_INTENT,
    );

    if (event?.type === "SEMANTIC_TOOL_SELECTED") {
      await this[LEGACY_INTENT_EXECUTOR]({ argumentsJson: event.arguments, callId: event.callId });
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
