import { CallSession as CallSessionV8 } from "./call-session-v8";
import { authorizeSpecializedFlow } from "./conversation-state-authority";
import { parseSemanticDecision } from "./semantic-router";

const CONVERSATION_INTENT = "conversation_intent";
const BaseConstructor = CallSessionV8 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV8.prototype as any;

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

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
  private createReservationIntentActiveV9 = false;

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === CONVERSATION_INTENT) {
      const semantic = parseSemanticDecision(event.arguments);
      const operation = semantic.dataRequirement === "RESERVATION" ? rawReservationOperation(event.arguments) : null;
      if (semantic.intent === "CONTINUE" && semantic.dataRequirement === "RESERVATION" && operation !== "QUERY" && operation !== "CANCEL") {
        this.createReservationIntentActiveV9 = true;
      }
      if ((this as any).reservationBookedThisCall === true || operation === "QUERY" || operation === "CANCEL") {
        this.createReservationIntentActiveV9 = false;
      }

      const reservationInProgress = (this.createReservationIntentActiveV9 || hasReservationDraft((this as any).reservationDraft))
        && (this as any).reservationBookedThisCall !== true;
      const authority = authorizeSpecializedFlow({
        lifecycleState: String((this as any).state ?? "active"),
        hangupStarted: (this as any).hangupStarted === true,
        reservationInProgress,
      }, semantic);

      (this as any).diagnostics?.checkpoint?.("CONVERSATION_STATE_AUTHORITY", {
        lifecycle_state: String((this as any).state ?? "active"),
        reservation_in_progress: reservationInProgress,
        reservation_intent_active: this.createReservationIntentActiveV9,
        classifier_requirement: semantic.dataRequirement,
        classifier_degraded: semantic.degraded,
        authorized_flow: authority.flow,
        authority_reason: authority.reason,
      });

      if (authority.reason === "CALL_TERMINAL") {
        (this as any).sendToolResult?.(event.call_id, { ok: true, action: "closing_already_in_progress" });
        return;
      }

      if (authority.flow === "RESERVATION" && semantic.dataRequirement !== "RESERVATION") {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(event.arguments ?? "{}") as Record<string, unknown>; } catch { parsed = {}; }
        const routed: RealtimeEvent = {
          ...event,
          arguments: JSON.stringify({ ...parsed, intent: "CONTINUE", data_requirement: "RESERVATION" }),
        };
        (this as any).diagnostics?.checkpoint?.("RESERVATION_ROUTING_RECOVERED_BY_STATE", {
          from_requirement: semantic.dataRequirement,
          reason: authority.reason,
        });
        await BasePrototype.handleRealtimeMessage.call(this, JSON.stringify(routed));
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
