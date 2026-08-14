import { CallSession as CallSessionV21 } from "./call-session-v21";

const BaseConstructor = CallSessionV21 as unknown as new (...args: any[]) => any;

const HANGUP_CONFIRMATION_TIMEOUT_MS = 2_500;
const HANGUP_RETRY_DELAY_MS = 400;
const HANGUP_MAX_IMMEDIATE_ATTEMPTS = 4;
const HANGUP_BACKGROUND_RETRY_MS = 5_000;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * v22 fixes the hangup acknowledgement boundary.
 *
 * A 2xx response from POST /hangup means the command was accepted; it is not
 * evidence that the phone channel has actually disconnected. The base session's
 * sideband close handler sets `socket = null`, so v22 treats that transport close
 * as the first reliable confirmation available inside this runtime.
 */
export class CallSession extends BaseConstructor {
  private hangupBackgroundRetryV22: ReturnType<typeof setTimeout> | null = null;

  private clearHangupBackgroundRetryV22(): void {
    if (this.hangupBackgroundRetryV22 !== null) {
      clearTimeout(this.hangupBackgroundRetryV22);
      this.hangupBackgroundRetryV22 = null;
    }
  }

  private async waitForHangupConfirmationV22(timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ((this as any).socket === null) return true;
      await sleep(50);
    }
    return (this as any).socket === null;
  }

  private async sendHangupRequestV22(callId: string, attempt: number, trigger: string): Promise<void> {
    const started = Date.now();
    const apiKey = requiredString((this as any).env?.OPENAI_API_KEY, "OPENAI_API_KEY");
    const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI hangup failed with HTTP ${response.status}: ${body.slice(0, 250)}`);
    }
    (this as any).diagnostics?.checkpoint?.("HANGUP_REQUEST_ACCEPTED", {
      attempt,
      trigger,
      http_status: response.status,
      elapsed_ms: Date.now() - started,
      completion_claimed: false,
    });
  }

  private scheduleBackgroundHangupRetryV22(): void {
    this.clearHangupBackgroundRetryV22();
    this.hangupBackgroundRetryV22 = setTimeout(() => {
      this.hangupBackgroundRetryV22 = null;
      if ((this as any).socket === null) {
        (this as any).diagnostics?.checkpoint?.("HANGUP_COMPLETED", {
          confirmation: "sideband_closed_before_background_retry",
        });
        return;
      }
      // Allow a new guarded attempt. The call remains in closing state, so no
      // business conversation resumes while the runtime keeps trying to end it.
      (this as any).hangupStarted = false;
      void this.performHangup("hangup_confirmation_background_retry");
    }, HANGUP_BACKGROUND_RETRY_MS);
  }

  private async performHangup(trigger: string): Promise<void> {
    const session = this as any;
    if (session.hangupStarted || !session.callId) return;

    this.clearHangupBackgroundRetryV22();
    session.hangupStarted = true;
    session.clearFinalFarewellWatchdog?.();
    session.resetExternalFlow?.();
    session.diagnostics?.checkpoint?.("HANGUP_STARTED", {
      trigger,
      confirmation_required: true,
      confirmation_source: "sideband_close",
    });

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= HANGUP_MAX_IMMEDIATE_ATTEMPTS; attempt += 1) {
      if (session.socket === null) {
        session.diagnostics?.checkpoint?.("HANGUP_COMPLETED", {
          attempt: attempt - 1,
          confirmation: "sideband_closed",
        });
        return;
      }

      try {
        await this.sendHangupRequestV22(session.callId, attempt, trigger);
      } catch (error) {
        lastError = error;
        session.diagnostics?.fail?.("HANGUP_ATTEMPT_FAILED", "OPENAI_HANGUP_REQUEST_FAILED", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < HANGUP_MAX_IMMEDIATE_ATTEMPTS) await sleep(HANGUP_RETRY_DELAY_MS);
        continue;
      }

      const confirmed = await this.waitForHangupConfirmationV22(HANGUP_CONFIRMATION_TIMEOUT_MS);
      if (confirmed) {
        session.diagnostics?.checkpoint?.("HANGUP_COMPLETED", {
          attempt,
          confirmation: "sideband_closed",
          request_was_only_acknowledged_before_confirmation: true,
        });
        return;
      }

      session.diagnostics?.fail?.("HANGUP_CONFIRMATION_TIMEOUT", "HANGUP_NOT_CONFIRMED", {
        attempt,
        confirmation_timeout_ms: HANGUP_CONFIRMATION_TIMEOUT_MS,
        socket_still_connected: session.socket !== null,
      });
      if (attempt < HANGUP_MAX_IMMEDIATE_ATTEMPTS) await sleep(HANGUP_RETRY_DELAY_MS);
    }

    // Do not lie by logging HANGUP_COMPLETED and do not reactivate conversation.
    // Keep the session in closing state and continue low-rate retries to limit the
    // cost of a phone channel that failed to disconnect after an accepted request.
    session.diagnostics?.fail?.("HANGUP_UNCONFIRMED", "HANGUP_RETRIES_EXHAUSTED", {
      immediate_attempts: HANGUP_MAX_IMMEDIATE_ATTEMPTS,
      socket_still_connected: session.socket !== null,
      last_error: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : null,
      background_retry_ms: HANGUP_BACKGROUND_RETRY_MS,
    });
    session.hangupStarted = true;
    this.scheduleBackgroundHangupRetryV22();
  }
}
