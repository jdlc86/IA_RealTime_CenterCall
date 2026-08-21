import type { CallTerminationRequest, CallTerminationResult } from "./call-termination-port.js";

export type HangupDiagnostics = {
  checkpoint?: (event: string, details?: Record<string, unknown>) => void;
  fail?: (event: string, code: string, details?: Record<string, unknown>) => void;
};

export type HangupControllerHost = {
  getCallId(): string | null;
  getSocketConnected(): boolean;
  getSourceCallControlId?(): string | null;
  terminateCall(request: CallTerminationRequest): Promise<CallTerminationResult>;
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function terminationFailure(result: CallTerminationResult): string {
  if (result.attempts.length === 0) return "No call termination transport available";
  return result.attempts
    .map((attempt) => `${attempt.transport}: ${attempt.error ?? `HTTP ${attempt.httpStatus ?? "unknown"}`}`)
    .join("; ");
}

/**
 * Lifecycle-facing hangup coordinator.
 *
 * Physical provider transport belongs to CallTerminationPort. This controller
 * owns only retry cadence, sideband-close confirmation and background recovery.
 * When a source call leg exists, SOURCE_ONLY preserves the historical behavior:
 * each retry stays on that authoritative source leg instead of silently changing
 * transport inside a single attempt.
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

  private sourceCallControlId(): string | null {
    const value = this.host.getSourceCallControlId?.();
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private transportAuthority(): "SOURCE_CALL_LEG" | "REALTIME_SESSION" {
    return this.sourceCallControlId() ? "SOURCE_CALL_LEG" : "REALTIME_SESSION";
  }

  private async sendHangupRequest(callId: string, attempt: number, trigger: string): Promise<void> {
    const sourceCallControlId = this.sourceCallControlId();
    const request: CallTerminationRequest = sourceCallControlId
      ? {
          sourceCallControlId,
          realtimeCallId: callId,
          fallbackMode: "SOURCE_ONLY",
        }
      : {
          realtimeCallId: callId,
          fallbackMode: "REALTIME_FALLBACK",
        };
    const result = await this.host.terminateCall(request);
    const accepted = result.attempts.find((candidate) => candidate.ok);
    if (!result.terminated || !accepted) throw new Error(terminationFailure(result));

    this.host.diagnostics?.checkpoint?.("HANGUP_REQUEST_ACCEPTED", {
      attempt,
      trigger,
      transport: accepted.transport,
      http_status: accepted.httpStatus ?? null,
      completion_claimed: false,
      termination_port: true,
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
      transport_authority: this.transportAuthority(),
      confirmation_required: true,
      confirmation_source: "sideband_close",
      termination_port: true,
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
        this.host.diagnostics?.fail?.("HANGUP_ATTEMPT_FAILED", "HANGUP_REQUEST_FAILED", {
          attempt,
          transport_authority: this.transportAuthority(),
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
