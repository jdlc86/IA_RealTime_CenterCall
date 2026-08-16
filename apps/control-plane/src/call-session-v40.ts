import { CallSession as CallSessionV39 } from "./call-session-v39";
import { isRetryableSidebandConnectError, SIDEBAND_CONNECT_RETRY_DELAYS_MS } from "./sideband-connect-retry";

const BaseConstructor = CallSessionV39 as unknown as new (...args: any[]) => any;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * v40 hardens only CallSession bootstrap.
 *
 * OpenAI can transiently return 404 when the monitoring/sideband websocket is
 * requested immediately after the SIP accept lifecycle. The historical base
 * implementation treats that single 404 as terminal, which leaves an otherwise
 * accepted phone call silent. v40 retries only that specific transient failure.
 * Authentication/configuration/server failures remain fail-fast.
 */
export class CallSession extends BaseConstructor {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/start") {
      return super.fetch(request);
    }

    const attempts = SIDEBAND_CONNECT_RETRY_DELAYS_MS.length + 1;
    let currentRequest = request.clone();

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await super.fetch(currentRequest);
      } catch (error) {
        const retryable = isRetryableSidebandConnectError(error);
        const retryDelayMs = SIDEBAND_CONNECT_RETRY_DELAYS_MS[attempt - 1];

        (this as any).diagnostics?.checkpoint?.("SIDEBAND_CONNECT_ATTEMPT_V40", {
          attempt,
          retryable,
          retry_scheduled: retryable && retryDelayMs !== undefined,
          retry_delay_ms: retryDelayMs ?? null,
        });

        if (!retryable || retryDelayMs === undefined) throw error;
        await sleep(retryDelayMs);
        currentRequest = request.clone();
      }
    }

    throw new Error("Realtime sideband retry lifecycle exhausted");
  }
}
