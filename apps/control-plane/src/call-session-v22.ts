import { CallSession as CallSessionV21 } from "./call-session-v21";
import { HangupController } from "./hangup-controller";
import { callTerminationPortFor } from "./call-termination-port.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { humanHandoffTransportRuntimeFor } from "./human-handoff-transport-runtime.js";

const BaseConstructor = CallSessionV21 as unknown as new (...args: any[]) => any;

/**
 * v22 remains the compatibility adapter for confirmed hangup behavior.
 * Retry/confirmation policy and the in-flight termination lock live in
 * HangupController; physical provider transport is delegated to
 * CallTerminationPort. Cross-generation lifecycle and source-leg state are
 * consumed only through neutral runtimes.
 */
export class CallSession extends BaseConstructor {
  private hangupControllerV22: HangupController | null = null;

  private getHangupControllerV22(): HangupController {
    if (!this.hangupControllerV22) {
      const session = this as any;
      const terminationPort = callTerminationPortFor(session);
      this.hangupControllerV22 = new HangupController({
        getCallId: () => typeof session.callId === "string" && session.callId.trim() ? session.callId : null,
        getSocketConnected: () => session.socket !== null,
        getSourceCallControlId: () => humanHandoffTransportRuntimeFor(this).transportContext().sourceCallControlId,
        terminateCall: (request) => terminationPort.terminate(request),
        clearFinalFarewellWatchdog: () => session.clearFinalFarewellWatchdog?.(),
        resetExternalFlow: () => session.resetExternalFlow?.(),
        diagnostics: session.diagnostics,
      });
    }
    return this.hangupControllerV22;
  }

  private async performHangup(trigger: string): Promise<void> {
    const session = this as any;

    // v2 historically inferred terminal intent from output_audio_buffer.stopped.
    // Once the lifecycle authority has already reached CLOSING, that inference
    // is superseded: only the explicit lifecycle HANGUP effect may reach transport.
    // Keep the legacy path available when lifecycle has not claimed terminality so
    // the assistant-hangup-commitment safety guard remains intact.
    if (trigger === "output_audio_buffer_stopped" && conversationLifecyclePortFor(this).isClosing()) {
      session.diagnostics?.checkpoint?.("LEGACY_AUDIO_STOP_HANGUP_SUPERSEDED_V22", {
        trigger,
        lifecycle_state: "CLOSING",
        authority: "conversation_lifecycle_port",
        transport_dispatched: false,
      });
      return;
    }

    await this.getHangupControllerV22().perform(trigger);
  }
}
