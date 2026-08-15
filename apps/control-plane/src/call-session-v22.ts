import { CallSession as CallSessionV21 } from "./call-session-v21";
import { HangupController } from "./hangup-controller";

const BaseConstructor = CallSessionV21 as unknown as new (...args: any[]) => any;

/**
 * v22 remains the compatibility adapter for confirmed hangup behavior.
 * The transport policy itself now lives in HangupController so later CallSession
 * consolidation does not need to inherit this implementation.
 */
export class CallSession extends BaseConstructor {
  private hangupControllerV22: HangupController | null = null;

  private getHangupControllerV22(): HangupController {
    if (!this.hangupControllerV22) {
      const session = this as any;
      this.hangupControllerV22 = new HangupController({
        getCallId: () => typeof session.callId === "string" && session.callId.trim() ? session.callId : null,
        getSocketConnected: () => session.socket !== null,
        getApiKey: () => session.env?.OPENAI_API_KEY,
        isHangupStarted: () => session.hangupStarted === true,
        setHangupStarted: (value) => { session.hangupStarted = value; },
        clearFinalFarewellWatchdog: () => session.clearFinalFarewellWatchdog?.(),
        resetExternalFlow: () => session.resetExternalFlow?.(),
        diagnostics: session.diagnostics,
      });
    }
    return this.hangupControllerV22;
  }

  private async performHangup(trigger: string): Promise<void> {
    await this.getHangupControllerV22().perform(trigger);
  }
}
