import { CallSession as CallSessionV45 } from "./call-session-v45-barge-in-semantic-authority";
import { sidebandCloseLifecycleEvent } from "./sideband-lifecycle-quiescence";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { turnConcurrencyCoordinatorFor } from "./turn-concurrency-coordinator.js";

const BaseConstructor = CallSessionV45 as unknown as new (...args: any[]) => any;

/** Transport observation adapter; lifecycle and turn lock are explicit ports. */
export class CallSession extends BaseConstructor {
  private observedSidebandSocketV46: WebSocket | null = null;

  private notifyLifecycleTransportClosedV46(reason: string): void {
    const session = this as any;
    const lifecycleEvent = sidebandCloseLifecycleEvent(reason);
    conversationLifecyclePortFor(this).transportClosed(lifecycleEvent.reason);
    turnConcurrencyCoordinatorFor(this).detachForTerminal(session, `transport_closed:${lifecycleEvent.reason}`);
    session.diagnostics?.checkpoint?.("SIDEBAND_LIFECYCLE_QUIESCED_V46", {
      reason,
      lifecycle_event: lifecycleEvent.type,
      realtime_speech_possible: false,
      lifecycle_authority: "conversation_lifecycle_port",
      turn_concurrency_detached: true,
      direct_version_state_mutation: false,
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
