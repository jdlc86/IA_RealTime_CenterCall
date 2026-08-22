export type HumanHandoffSourceLegCommandResult = Readonly<{
  ok: boolean;
  httpStatus?: number;
  alreadyEnded: boolean;
  error?: string;
}>;

export type HumanHandoffSourceLegSpeechRequest = Readonly<{
  sourceCallControlId: string;
  text: string;
  clientState: string;
  commandId: string;
}>;

export type HumanHandoffSourceLegHangupRequest = Readonly<{
  sourceCallControlId: string;
  commandId: string;
}>;

type HumanHandoffSourceLegHost = object & {
  env?: Record<string, unknown>;
};

type FetchLike = typeof fetch;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function responseDetail(response: Response): Promise<string> {
  try { return (await response.text()).slice(0, 250); } catch { return ""; }
}

function alreadyEnded(status: number, detail: string): boolean {
  return status === 422 && (detail.includes("90018") || detail.length === 0);
}

/**
 * Provider boundary for the physical source leg used by terminal human-handoff
 * presentation. Handoff policy, persistence, watchdogs and lifecycle remain
 * owned by the caller.
 */
export class HumanHandoffSourceLegRuntime {
  constructor(
    private readonly host: HumanHandoffSourceLegHost,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  private apiKey(): string {
    const value = nonEmpty(this.host.env?.TELNYX_API_KEY);
    if (!value) throw new Error("TELNYX_API_KEY unavailable");
    return value;
  }

  async speakTerminal(request: HumanHandoffSourceLegSpeechRequest): Promise<HumanHandoffSourceLegCommandResult> {
    try {
      const response = await this.fetcher(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(request.sourceCallControlId)}/actions/speak`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey()}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            payload: request.text,
            payload_type: "text",
            voice: "Azure.es-ES-ElviraNeural",
            language: "es-ES",
            service_level: "premium",
            client_state: request.clientState,
            command_id: request.commandId,
            target_legs: "self",
          }),
        },
      );
      if (response.ok) return { ok: true, httpStatus: response.status, alreadyEnded: false };
      const detail = await responseDetail(response);
      if (alreadyEnded(response.status, detail)) {
        return { ok: false, httpStatus: response.status, alreadyEnded: true };
      }
      return {
        ok: false,
        httpStatus: response.status,
        alreadyEnded: false,
        error: `Source-leg speech HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    } catch (error) {
      return { ok: false, alreadyEnded: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async hangup(request: HumanHandoffSourceLegHangupRequest): Promise<HumanHandoffSourceLegCommandResult> {
    try {
      const response = await this.fetcher(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(request.sourceCallControlId)}/actions/hangup`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey()}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ command_id: request.commandId }),
        },
      );
      if (response.ok) return { ok: true, httpStatus: response.status, alreadyEnded: false };
      const detail = await responseDetail(response);
      if (response.status === 422) {
        return { ok: false, httpStatus: response.status, alreadyEnded: true };
      }
      return {
        ok: false,
        httpStatus: response.status,
        alreadyEnded: false,
        error: `Source-leg hangup HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    } catch (error) {
      return { ok: false, alreadyEnded: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

const runtimes = new WeakMap<object, HumanHandoffSourceLegRuntime>();

export function humanHandoffSourceLegPortFor(host: HumanHandoffSourceLegHost): HumanHandoffSourceLegRuntime {
  let runtime = runtimes.get(host);
  if (!runtime) {
    runtime = new HumanHandoffSourceLegRuntime(host);
    runtimes.set(host, runtime);
  }
  return runtime;
}
