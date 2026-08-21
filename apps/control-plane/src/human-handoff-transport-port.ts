import { humanHandoffTransportRuntimeFor } from "./human-handoff-transport-runtime.js";

export type HumanHandoffTransferRequest = Readonly<{
  sourceCallControlId: string;
  destinationPhone: string;
  originatingNumber: string;
  answerTimeoutSeconds: number;
  commandId: string;
  correlationState: string;
}>;

export type HumanHandoffTransferResult = Readonly<{
  started: boolean;
  httpStatus?: number;
  error?: string;
}>;

export type HumanHandoffTransportPort = Readonly<{
  cancelTransferWatchdog(): void;
  markTransferred(targetCallControlId: string | null): Promise<void>;
  startTransfer(request: HumanHandoffTransferRequest): Promise<HumanHandoffTransferResult>;
}>;

type HumanHandoffTransportHost = object & {
  env?: Record<string, unknown>;
};

type FetchLike = typeof fetch;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Provider edge for human-handoff source-leg transport.
 * Session generations own handoff policy/lifecycle only; provider credentials,
 * endpoints and transfer wire payloads stay behind this port.
 */
export class HumanHandoffTransportAdapter implements HumanHandoffTransportPort {
  private readonly runtime;

  constructor(
    private readonly session: HumanHandoffTransportHost,
    private readonly fetcher: FetchLike = fetch,
  ) {
    this.runtime = humanHandoffTransportRuntimeFor(session);
  }

  cancelTransferWatchdog(): void {
    this.runtime.cancelTransferWatchdog();
  }

  async markTransferred(targetCallControlId: string | null): Promise<void> {
    await this.runtime.markTransferred(this.session, targetCallControlId);
  }

  async startTransfer(request: HumanHandoffTransferRequest): Promise<HumanHandoffTransferResult> {
    try {
      const apiKey = nonEmpty(this.session.env?.TELNYX_API_KEY);
      if (!apiKey) throw new Error("TELNYX_API_KEY unavailable");
      const response = await this.fetcher(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(request.sourceCallControlId)}/actions/transfer`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            to: request.destinationPhone,
            from: request.originatingNumber,
            timeout_secs: request.answerTimeoutSeconds,
            command_id: request.commandId,
            client_state: request.correlationState,
            target_leg_client_state: request.correlationState,
          }),
        },
      );
      if (!response.ok) {
        let detail = "";
        try { detail = (await response.text()).slice(0, 250); } catch {}
        throw new Error(`Telnyx transfer HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      return { started: true, httpStatus: response.status };
    } catch (error) {
      return {
        started: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

const ports = new WeakMap<object, HumanHandoffTransportAdapter>();

/** Version-neutral facade over the composed human-handoff transport runtime. */
export function humanHandoffTransportPortFor(session: HumanHandoffTransportHost): HumanHandoffTransportPort {
  let port = ports.get(session);
  if (!port) {
    port = new HumanHandoffTransportAdapter(session);
    ports.set(session, port);
  }
  return port;
}
