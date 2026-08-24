import { CallSession as CallSessionV46 } from "./call-session-v46-sideband-lifecycle";
import {
  adaptRealtimeProviderEvents,
  installRealtimeSessionPolicyTransform,
} from "./realtime-provider-runtime.js";
import { authoritativeTemporalContextPortFor } from "./authoritative-temporal-context-runtime.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import {
  authoritativeMadridNowContext,
  stripAuthoritativeNowContext,
  withAuthoritativeNowContext,
} from "./temporal-grounding";

const BaseConstructor = CallSessionV46 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV46.prototype as any;

function hasUsableTranscript(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\s+/g, " ").trim().length > 0;
}

/**
 * v48 owns only authoritative current-time grounding.
 *
 * It does not become the backend authority for reservation validity:
 * ReservationDatetimeRuntime and the reservation backend still reject invalid,
 * past or out-of-hours datetimes.
 * Initial instructions are enriched through the neutral bootstrap/session transform.
 * Caller-turn refreshes use the semantic temporal-context port, not a provider wire
 * operation. Retired v47 reservation-search state is bypassed; shared semantic tool
 * authority is owned by the neutral authorization runtime.
 */
export class CallSession extends BaseConstructor {
  private temporalPolicyTransformInstalledV48 = false;
  private latestBaseInstructionsV48: string | null = null;
  private lastRefreshedItemIdV48: string | null = null;

  private enrichTemporalInstructionsV48(instructions: string, source: string): string {
    const baseInstructions = stripAuthoritativeNowContext(instructions);
    this.latestBaseInstructionsV48 = baseInstructions;
    const now = new Date();
    const temporal = authoritativeMadridNowContext(now);
    (this as any).diagnostics?.checkpoint?.("AUTHORITATIVE_CLOCK_INJECTED_V48", {
      source,
      timezone: temporal.timezone,
      now_iso: temporal.now_iso,
      calendar_date: temporal.calendar_date,
      clock_time: temporal.clock_time,
      weekday: temporal.weekday,
      backend_validation_still_authoritative: true,
      provider_session_policy_transform: true,
    });
    return withAuthoritativeNowContext(baseInstructions, now);
  }

  private installTemporalPolicyTransformV48(): void {
    if (this.temporalPolicyTransformInstalledV48) return;
    this.temporalPolicyTransformInstalledV48 = true;
    installRealtimeSessionPolicyTransform(this as any, (update) => {
      if (typeof update.instructions !== "string") return update;
      return {
        ...update,
        instructions: this.enrichTemporalInstructionsV48(update.instructions, "session_instructions_update"),
      };
    });
  }

  private refreshTemporalContextForCallerTurnV48(itemId: string, transcript: string): void {
    if (!itemId || itemId === this.lastRefreshedItemIdV48 || !this.latestBaseInstructionsV48) return;
    const session = this as any;
    if (!session.socket || conversationLifecyclePortFor(this).isTerminal()) return;

    this.lastRefreshedItemIdV48 = itemId;
    const now = new Date();
    const temporal = authoritativeMadridNowContext(now);
    authoritativeTemporalContextPortFor(session).refresh({
      baseInstructions: this.latestBaseInstructionsV48,
      now,
      callerTurn: { itemId, transcript },
    });
    session.diagnostics?.checkpoint?.("AUTHORITATIVE_CLOCK_REFRESHED_FOR_CALLER_TURN_V48", {
      item_id: itemId,
      timezone: temporal.timezone,
      now_iso: temporal.now_iso,
      calendar_date: temporal.calendar_date,
      clock_time: temporal.clock_time,
      weekday: temporal.weekday,
      refresh_boundary: "completed_usable_caller_transcription",
      backend_validation_still_authoritative: true,
      lifecycle_authority: "conversation_lifecycle_port",
      provider_temporal_context_port: true,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") {
      this.installTemporalPolicyTransformV48();
    }
    return super.fetch(request);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    for (const event of adaptRealtimeProviderEvents(data)) {
      if (
        event.type === "CALLER_TRANSCRIPT_COMPLETED"
        && hasUsableTranscript(event.transcript)
        && typeof event.itemId === "string"
      ) {
        this.refreshTemporalContextForCallerTurnV48(event.itemId, event.transcript);
      }
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
