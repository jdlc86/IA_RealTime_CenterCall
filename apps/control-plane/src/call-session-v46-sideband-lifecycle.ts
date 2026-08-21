import { CallSession as CallSessionV45 } from "./call-session-v45-barge-in-semantic-authority";
import { sidebandCloseLifecycleEvent } from "./sideband-lifecycle-quiescence";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { turnConcurrencyCoordinatorFor } from "./turn-concurrency-coordinator.js";
import { sidebandLifecyclePortFor, type SidebandCloseObservation } from "./sideband-lifecycle-port.js";

const BaseConstructor = CallSessionV45 as unknown as new (...args: any[]) => any;

/** Transport observation adapter; lifecycle and turn lock are explicit ports. */
export class CallSession extends BaseConstructor {
  private sidebandCloseObserverInstalledV46 = false;

  private observeLifecycleTransportClosedV46(observation: SidebandCloseObservation): void {
    const session = this as any;
    const lifecycleEvent = sidebandCloseLifecycleEvent(observation.reason);
    const lifecycle = conversationLifecyclePortFor(this);
    session.diagnostics?.checkpoint?.("SIDEBAND_CLOSE_OBSERVED_V46", {
      close_code: observation.closeCode,
      close_reason: observation.providerReason,
      was_clean: observation.wasClean,
      lifecycle_terminal_before_transport_notification: lifecycle.isTerminal(),
      lifecycle_authority: "conversation_lifecycle_port",
      transport_observation_port: "sideband_lifecycle_port",
    });
    conversationLifecyclePortFor(this).transportClosed(lifecycleEvent.reason);
    turnConcurrencyCoordinatorFor(this).detachForTerminal(session, `transport_closed:${lifecycleEvent.reason}`);
    session.diagnostics?.checkpoint?.("SIDEBAND_LIFECYCLE_QUIESCED_V46", {
      reason: observation.reason,
      lifecycle_event: lifecycleEvent.type,
      realtime_speech_possible: false,
      lifecycle_authority: "conversation_lifecycle_port",
      turn_concurrency_detached: true,
      direct_version_state_mutation: false,
      stale_deadline_speech_blocked_by_state_invalidation: true,
    });
  }

  private installSidebandCloseBoundaryV46(): void {
    if (this.sidebandCloseObserverInstalledV46) return;
    this.sidebandCloseObserverInstalledV46 = true;
    sidebandLifecyclePortFor(this).installCloseObserver((observation) => {
      this.observeLifecycleTransportClosedV46(observation);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isStart = request.method === "POST" && url.pathname === "/start";
    if (isStart) this.installSidebandCloseBoundaryV46();
    const response = await super.fetch(request);
    if (isStart && response.ok && !(this as any).socket) {
      await sidebandLifecyclePortFor(this).transportClosed({
        reason: "socket_absent_after_start",
        closeCode: null,
        providerReason: "",
        wasClean: null,
      });
    }
    return response;
  }
}
