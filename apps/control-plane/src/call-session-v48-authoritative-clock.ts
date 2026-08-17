import { CallSession as CallSessionV47 } from "./call-session-v47-reservation-search-turn-authority";
import {
  authoritativeMadridNowContext,
  stripAuthoritativeNowContext,
  withAuthoritativeNowContext,
} from "./temporal-grounding";

const BaseConstructor = CallSessionV47 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV47.prototype as any;

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  transcript?: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function parseEvent(data: unknown): RealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEvent; } catch { return null; }
}

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
 *
 * Important architectural constraint: lower layers may update session
 * instructions. v48 therefore wraps send() before /start reaches them, captures
 * the latest base instructions, and appends/replaces only its own marked
 * temporal suffix. It never replaces another layer's prompt authority.
 */
export class CallSession extends BaseConstructor {
  private temporalSendBoundaryInstalledV48 = false;
  private originalSendV48: ((message: unknown) => void) | null = null;
  private latestBaseInstructionsV48: string | null = null;
  private lastRefreshedItemIdV48: string | null = null;

  private installTemporalSendBoundaryV48(): void {
    if (this.temporalSendBoundaryInstalledV48) return;
    const session = this as any;
    const currentSend = session.send;
    if (typeof currentSend !== "function") return;

    this.temporalSendBoundaryInstalledV48 = true;
    this.originalSendV48 = currentSend.bind(this);
    session.send = (message: any) => {
      if (message?.type === "session.update" && typeof message?.session?.instructions === "string") {
        const baseInstructions = stripAuthoritativeNowContext(message.session.instructions);
        this.latestBaseInstructionsV48 = baseInstructions;
        const now = new Date();
        const temporal = authoritativeMadridNowContext(now);
        const enriched = {
          ...message,
          session: {
            ...message.session,
            instructions: withAuthoritativeNowContext(baseInstructions, now),
          },
        };
        session.diagnostics?.checkpoint?.("AUTHORITATIVE_CLOCK_INJECTED_V48", {
          source: "session_instructions_update",
          timezone: temporal.timezone,
          now_iso: temporal.now_iso,
          calendar_date: temporal.calendar_date,
          clock_time: temporal.clock_time,
          weekday: temporal.weekday,
          backend_validation_still_authoritative: true,
        });
        this.originalSendV48?.(enriched);
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
    session.send?.({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: withAuthoritativeNowContext(this.latestBaseInstructionsV48, now),
      },
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
    const event = parseEvent(data);
    if (
      event?.type === "conversation.item.input_audio_transcription.completed"
      && hasUsableTranscript(event.transcript)
      && typeof event.item_id === "string"
    ) {
      this.refreshTemporalContextForCallerTurnV48(event.item_id);
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
