import { CallSession as CallSessionV47 } from "./call-session-v47-reservation-search-turn-authority";
import {
  adaptRealtimeProviderEvents,
  installRealtimeSessionPolicyTransform,
  realtimeCommandPortFor,
} from "./realtime-provider-runtime.js";
import {
  authoritativeMadridNowContext,
  stripAuthoritativeNowContext,
  withAuthoritativeNowContext,
} from "./temporal-grounding";

const BaseConstructor = CallSessionV47 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV47.prototype as any;

function hasUsableTranscript(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\s+/g, " ").trim().length > 0;
}

/**
 * v48 owns only authoritative current-time grounding.
 *
 * It does not become the backend authority for reservation validity: v20 and
 * the reservation backend still reject invalid/past/out-of-hours datetimes.
 * Instead, v48 keeps the model's interpretation context synchronized with the
 * Worker clock in Europe/Madrid.
 */
export class CallSession extends BaseConstructor {
  private temporalSendBoundaryInstalledV48 = false;
  private originalSendV48: ((message: unknown) => void) | null = null;
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
    });
    return withAuthoritativeNowContext(baseInstructions, now);
  }

  private installTemporalSendBoundaryV48(): void {
    if (this.temporalSendBoundaryInstalledV48) return;
    const session = this as any;
    const currentSend = session.send;
    if (typeof currentSend !== "function") return;

    this.temporalSendBoundaryInstalledV48 = true;

    // Provider-neutral authority for migrated session policy updates.
    installRealtimeSessionPolicyTransform(session, (update) => {
      if (typeof update.instructions !== "string") return update;
      return {
        ...update,
        instructions: this.enrichTemporalInstructionsV48(update.instructions, "session_instructions_update"),
      };
    });

    // Compatibility fallback for historical layers that still emit raw OpenAI
    // session.update messages. Temporal markers make this transformation idempotent.
    this.originalSendV48 = currentSend.bind(this);
    session.send = (message: any) => {
      if (message?.type === "session.update" && typeof message?.session?.instructions === "string") {
        this.originalSendV48?.({
          ...message,
          session: {
            ...message.session,
            instructions: this.enrichTemporalInstructionsV48(message.session.instructions, "session_instructions_update"),
          },
        });
        return;
      }
      this.originalSendV48?.(message);
    };
  }

  private refreshTemporalContextForCallerTurnV48(itemId: string): void {
    if (!itemId || itemId === this.lastRefreshedItemIdV48 || !this.latestBaseInstructionsV48) return;
    const session = this as any;
    if (session.state === "closing" || session.hangupStarted || !session.socket) return;

    this.lastRefreshedItemIdV48 = itemId;
    const now = new Date();
    const temporal = authoritativeMadridNowContext(now);
    realtimeCommandPortFor(session).updateSessionPolicy({
      instructions: withAuthoritativeNowContext(this.latestBaseInstructionsV48, now),
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
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") {
      this.installTemporalSendBoundaryV48();
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
        this.refreshTemporalContextForCallerTurnV48(event.itemId);
      }
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
