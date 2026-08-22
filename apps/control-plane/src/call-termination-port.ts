export type CallTerminationTransport = "TELNYX_SOURCE_LEG" | "OPENAI_REALTIME_FALLBACK";
export type CallTerminationFallbackMode = "REALTIME_FALLBACK" | "SOURCE_ONLY";

export type CallTerminationAttempt = Readonly<{
  transport: CallTerminationTransport;
  ok: boolean;
  httpStatus?: number;
  terminalEvidence?: "ALREADY_TERMINATED";
  error?: string;
}>;

export type CallTerminationRequest = Readonly<{
  sourceCallControlId?: string | null;
  realtimeCallId?: string | null;
  commandId?: string;
  fallbackMode?: CallTerminationFallbackMode;
}>;

export type CallTerminationResult = Readonly<{
  terminated: boolean;
  terminationConfirmed?: boolean;
  attempts: readonly CallTerminationAttempt[];
}>;

type CallTerminationHost = object & {
  env?: Record<string, unknown>;
};

type FetchLike = typeof fetch;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function responseDetail(response: Response): Promise<string> {
  try { return (await response.text()).slice(0, 250); } catch { return ""; }
}

function isTelnyxAlreadyTerminated(status: number, detail: string): boolean {
  if (status !== 422 || !detail) return false;
  try {
    const payload = JSON.parse(detail) as { errors?: Array<{ code?: unknown }> };
    if (payload.errors?.some((error) => String(error.code ?? "") === "90018")) return true;
  } catch { /* fall through to the provider-code check */ }
  return /\b90018\b/.test(detail);
}

function responseFailure(status: number, detail: string, label: string): string {
  return `${label} HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

/**
 * Provider boundary for physical call termination only.
 * Lifecycle, retries, watchdogs and business state remain owned by callers.
 */
export class CallTerminationRuntime {
  constructor(
    private readonly host: CallTerminationHost,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async terminate(request: CallTerminationRequest): Promise<CallTerminationResult> {
    const attempts: CallTerminationAttempt[] = [];
    const sourceCallControlId = nonEmpty(request.sourceCallControlId);
    const realtimeCallId = nonEmpty(request.realtimeCallId);
    const fallbackMode = request.fallbackMode ?? "REALTIME_FALLBACK";

    if (sourceCallControlId) {
      try {
        const apiKey = nonEmpty(this.host.env?.TELNYX_API_KEY);
        if (!apiKey) throw new Error("TELNYX_API_KEY unavailable");
        const response = await this.fetcher.call(
          globalThis,
          `https://api.telnyx.com/v2/calls/${encodeURIComponent(sourceCallControlId)}/actions/hangup`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(request.commandId ? { command_id: request.commandId } : {}),
          },
        );
        if (!response.ok) {
          const detail = await responseDetail(response);
          if (isTelnyxAlreadyTerminated(response.status, detail)) {
            attempts.push({
              transport: "TELNYX_SOURCE_LEG",
              ok: true,
              httpStatus: response.status,
              terminalEvidence: "ALREADY_TERMINATED",
            });
            return { terminated: true, terminationConfirmed: true, attempts };
          }
          throw new Error(responseFailure(response.status, detail, "Telnyx hangup"));
        }
        attempts.push({ transport: "TELNYX_SOURCE_LEG", ok: true, httpStatus: response.status });
        return { terminated: true, attempts };
      } catch (error) {
        attempts.push({
          transport: "TELNYX_SOURCE_LEG",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        if (fallbackMode === "SOURCE_ONLY") return { terminated: false, attempts };
      }
    }

    if (realtimeCallId) {
      try {
        const apiKey = nonEmpty(this.host.env?.OPENAI_API_KEY);
        if (!apiKey) throw new Error("OPENAI_API_KEY unavailable");
        const response = await this.fetcher.call(
          globalThis,
          `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(realtimeCallId)}/hangup`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        );
        if (!response.ok) {
          const detail = await responseDetail(response);
          throw new Error(responseFailure(response.status, detail, "Realtime hangup"));
        }
        attempts.push({ transport: "OPENAI_REALTIME_FALLBACK", ok: true, httpStatus: response.status });
        return { terminated: true, attempts };
      } catch (error) {
        attempts.push({
          transport: "OPENAI_REALTIME_FALLBACK",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { terminated: false, attempts };
  }
}

const runtimes = new WeakMap<object, CallTerminationRuntime>();

export function callTerminationPortFor(host: CallTerminationHost): CallTerminationRuntime {
  let runtime = runtimes.get(host);
  if (!runtime) {
    runtime = new CallTerminationRuntime(host);
    runtimes.set(host, runtime);
  }
  return runtime;
}
