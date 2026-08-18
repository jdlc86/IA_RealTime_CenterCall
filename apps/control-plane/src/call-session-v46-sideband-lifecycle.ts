import { CallSession as CallSessionV45 } from "./call-session-v45-barge-in-semantic-authority";
import { sidebandCloseLifecycleEvent } from "./sideband-lifecycle-quiescence";

const BaseConstructor = CallSessionV45 as unknown as new (...args: any[]) => any;

/**
 * v46 owns only the transport observation boundary. Once the OpenAI realtime
 * sideband closes, it reports that deterministic fact to v18 and detaches any
 * turn-concurrency ownership that can no longer complete. It does not mutate
 * conversation timers, presence state, or semantic lifecycle fields directly.
 *
 * Live incident: a call entered WAITING_FOR_CALLER, its sideband closed, and a
 * stale silence-close deadline later attempted spoken closing against socket=null.
 * The lifecycle now owns invalidation of all realtime-dependent deadlines when
 * it receives transport_closed. The same terminal boundary also detaches v36's
 * semantic turn lock so its watchdog cannot survive after transport death.
 */
export class CallSession extends BaseConstructor {
  private observedSidebandSocketV46: WebSocket | null = null;

  private notifyLifecycleTransportClosedV46(reason: string): void {
    const session = this as any;
    const lifecycleEvent = sidebandCloseLifecycleEvent(reason);
    session.observeRealtimeTransportClosedV18?.(lifecycleEvent.reason);
    session.detachTurnConcurrencyForTerminalV36?.(`transport_closed:${lifecycleEvent.reason}`);
    session.diagnostics?.checkpoint?.("SIDEBAND_LIFECYCLE_QUIESCED_V46", {
      reason,
      lifecycle_event: lifecycleEvent.type,
      realtime_speech_possible: false,
      lifecycle_authority: "ConversationTurnLifecycle",
      turn_concurrency_detached: true,
      direct_v18_state_mutation: false,
      stale_deadline_speech_blocked_by_state_invalidation: true,
    });
  }

  private installSidebandCloseBoundaryV46(): void {
    const socket = (this as any).socket as WebSocket | null;

    if (!socket) {
      this.observedSidebandSocketV46 = null;
      this.notifyLifecycleTransportClosedV46("socket_absent_after_start");
      return;
    }

    if (this.observedSidebandSocketV46 === socket) return;
    this.observedSidebandSocketV46 = socket;
    socket.addEventListener("close", (event) => {
      const closeEvent = event as CloseEvent;
      const session = this as any;
      session.diagnostics?.checkpoint?.("SIDEBAND_CLOSE_OBSERVED_V46", {
        close_code: typeof closeEvent.code === "number" ? closeEvent.code : null,
        close_reason: typeof closeEvent.reason === "string" ? closeEvent.reason : "",
        was_clean: typeof closeEvent.wasClean === "boolean" ? closeEvent.wasClean : null,
        session_state: session.state ?? null,
        hangup_started: Boolean(session.hangupStarted),
        observed_socket_matches_active: session.socket === socket,
      });
      if (this.observedSidebandSocketV46 === socket) this.observedSidebandSocketV46 = null;
      this.notifyLifecycleTransportClosedV46("sideband_closed");
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
