import { CallSession as CallSessionV45 } from "./call-session-v45-barge-in-semantic-authority";
import { sidebandCloseQuiescenceActions } from "./sideband-lifecycle-quiescence";

const BaseConstructor = CallSessionV45 as unknown as new (...args: any[]) => any;

type TimerHandle = ReturnType<typeof setTimeout> | null;

/**
 * v46 owns one transport/lifecycle boundary only: once the OpenAI realtime
 * sideband closes, v18 conversation deadlines that can request future speech
 * must become inert.
 *
 * Live incident: a call entered WAITING_FOR_CALLER, its sideband closed, and a
 * stale silence-close deadline fired later while the Durable Object was serving
 * an unrelated internal /human-handoff/context fetch. The deadline called
 * beginClosing -> createSpokenResponse against socket=null and threw
 * "Realtime sideband socket is not connected".
 *
 * We do not weaken send(), swallow the exception, infer a semantic outcome, or
 * add timers. The transport close itself is the deterministic invalidation
 * boundary for realtime-dependent conversation deadlines.
 */
export class CallSession extends BaseConstructor {
  private observedSidebandSocketV46: WebSocket | null = null;

  private clearTimerFieldV46(field: "presenceTimerV18" | "silenceCloseTimerV18" | "maxCallTimerV18"): void {
    const session = this as any;
    const timer = session[field] as TimerHandle;
    if (timer !== null && timer !== undefined) clearTimeout(timer);
    session[field] = null;
  }

  private quiesceRealtimeConversationDeadlinesV46(reason: string): void {
    const session = this as any;
    const actions = sidebandCloseQuiescenceActions();

    for (const action of actions) {
      switch (action) {
        case "CLEAR_PRESENCE_TIMER":
          this.clearTimerFieldV46("presenceTimerV18");
          break;
        case "CLEAR_SILENCE_CLOSE_TIMER":
          this.clearTimerFieldV46("silenceCloseTimerV18");
          break;
        case "CLEAR_MAX_CALL_TIMER":
          this.clearTimerFieldV46("maxCallTimerV18");
          break;
        case "CLEAR_PRESENCE_RESPONSE_STATE":
          session.presenceRequestPendingV18 = false;
          session.presenceResponseIdV18 = null;
          break;
      }
    }

    session.diagnostics?.checkpoint?.("SIDEBAND_LIFECYCLE_QUIESCED_V46", {
      reason,
      realtime_speech_possible: false,
      presence_timer_cleared: true,
      silence_close_timer_cleared: true,
      max_call_timer_cleared: true,
      stale_deadline_speech_blocked_by_state_invalidation: true,
    });
  }

  private installSidebandCloseBoundaryV46(): void {
    const socket = (this as any).socket as WebSocket | null;

    if (!socket) {
      this.observedSidebandSocketV46 = null;
      this.quiesceRealtimeConversationDeadlinesV46("socket_absent_after_start");
      return;
    }

    if (this.observedSidebandSocketV46 === socket) return;
    this.observedSidebandSocketV46 = socket;
    socket.addEventListener("close", () => {
      if (this.observedSidebandSocketV46 === socket) this.observedSidebandSocketV46 = null;
      this.quiesceRealtimeConversationDeadlinesV46("sideband_closed");
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isStart = request.method === "POST" && url.pathname === "/start";
    const response = await super.fetch(request);

    if (isStart && response.ok) this.installSidebandCloseBoundaryV46();
    return response;
  }
}
