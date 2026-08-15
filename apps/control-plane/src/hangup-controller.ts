export type HangupDiagnostics = {
  checkpoint?: (event: string, details?: Record<string, unknown>) => void;
  fail?: (event: string, code: string, details?: Record<string, unknown>) => void;
};

export type HangupControllerHost = {
  getCallId(): string | null;
  getSocketConnected(): boolean;
  getApiKey(): string;
  isHangupStarted(): boolean;
  setHangupStarted(value: boolean): void;
  clearFinalFarewellWatchdog(): void;
  resetExternalFlow(): void;
  diagnostics?: HangupDiagnostics;
};

export type HangupControllerOptions = {
  confirmationTimeoutMs?: number;
  retryDelayMs?: number;
  maxImmediateAttempts?: number;
  backgroundRetryMs?: number;
};

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 2_500;
const DEFAULT_RETRY_DELAY_MS = 400;
const DEFAULT_MAX_IMMEDIATE_ATTEMPTS = 4;
const DEFAULT_BACKGROUND_RETRY_MS = 5_000;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transport-level hangup controller.
 * HTTP 2xx only acknowledges the hangup request; completion is emitted only
 * after the realtime sideband is actually disconnected.
 */
export class HangupController {
  private readonly confirmationTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxImmediateAttempts: number;
  private readonly backgroundRetryMs: number;
  private backgroundRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: HangupControllerHost, options: HangupControllerOptions = {}) {
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxImmediateAttempts = options.maxImmediateAttempts ?? DEFAULT_MAX_IMMEDIATE_ATTEMPTS;
    this.backgroundRetryMs = options.backgroundRetryMs ?? DEFAULT_BACKGROUND_RETRY_MS;
  }

  dispose(): void {
    this.clearBackgroundRetry();
  }

  private clearBackgroundRetry(): void {
    if (this.backgroundRetry !== null) {
      clearTimeout(this.backgroundRetry);
      this.backgroundRetry = null;
    }
  }

  private async waitForConfirmation(): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < this.confirmationTimeoutMs) {
      if (!this.host.getSocketConnected()) return true;
      await sleep(50);
    }
    return !this.host.getSocketConnected();
  }

  private async sendHangupRequest(callId: string, attempt: number, trigger: string): Promise<void> {
    const started = Date.now();
    const apiKey = requiredString(this.host.getApiKey(), "OPENAI_API_KEY");
    const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI hangup failed with HTTP ${response.status}: ${body.slice(0, 250)}`);
    }
    this.host.diagnostics?.checkpoint?.("HANGUP_REQUEST_ACCEPTED", {
      attempt,
      trigger,
      http_status: response.status,
      elapsed_ms: Date.now() - started,
      completion_claimed: false,
    });
  }

  private scheduleBackgroundRetry(): void {
    this.clearBackgroundRetry();
    this.backgroundRetry = setTimeout(() => {
      this.backgroundRetry = null;
      if (!this.host.getSocketConnected()) {
        this.host.diagnostics?.checkpoint?.("HANGUP_COMPLETED", {
          confirmation: "sideband_closed_before_background_retry",
        });
        return;
      }
      this.host.setHangupStarted(false);
      void this.perform("hangup_confirmation_background_retry");
    }, this.backgroundRetryMs);
  }

  async perform(trigger: string): Promise<void> {
    const callId = this.host.getCallId();
    if (this.host.isHangupStarted() || !callId) return;

    this.clearBackgroundRetry();
    this.host.setHangupStarted(true);
    this.host.clearFinalFarewellWatchdog();
    this.host.resetExternalFlow();
    this.host.diagnostics?.checkpoint?.("HANGUP_STARTED", {
      trigger,
      confirmation_required: true,
      confirmation_source: "sideband_close",
    });

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxImmediateAttempts; attempt += 1) {
      if (!this.host.getSocketConnected()) {
        this.host.diagnostics?.checkpoint?.("HANGUP_COMPLETED", {
          attempt: attempt - 1,
          confirmation: "sideband_closed",
        });
        return;
      }

      try {
        await this.sendHangupRequest(callId, attempt, trigger);
      } catch (error) {
        lastError = error;
        this.host.diagnostics?.fail?.("HANGUP_ATTEMPT_FAILED", "OPENAI_HANGUP_REQUEST_FAILED", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < this.maxImmediateAttempts) await sleep(this.retryDelayMs);
        continue;
      }

      const confirmed = await this.waitForConfirmation();
      if (confirmed) {
        this.host.diagnostics?.checkpoint?.("HANGUP_COMPLETED", {
          attempt,
          confirmation: "sideband_closed",
          request_was_only_acknowledged_before_confirmation: true,
        });
        return;
      }

      this.host.diagnostics?.fail?.("HANGUP_CONFIRMATION_TIMEOUT", "HANGUP_NOT_CONFIRMED", {
        attempt,
        confirmation_timeout_ms: this.confirmationTimeoutMs,
        socket_still_connected: this.host.getSocketConnected(),
      });
      if (attempt < this.maxImmediateAttempts) await sleep(this.retryDelayMs);
    }

    this.host.diagnostics?.fail?.("HANGUP_UNCONFIRMED", "HANGUP_RETRIES_EXHAUSTED", {
      immediate_attempts: this.maxImmediateAttempts,
      socket_still_connected: this.host.getSocketConnected(),
      last_error: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : null,
      background_retry_ms: this.backgroundRetryMs,
    });
    this.host.setHangupStarted(true);
    this.scheduleBackgroundRetry();
  }
}
