export type TelnyxGeminiStreamingTargetLegs = "self" | "opposite" | "both";

export type TelnyxGeminiStreamingCommandResult = Readonly<{
  ok: boolean;
  httpStatus?: number;
  alreadyEnded: boolean;
  error?: string;
}>;

export type TelnyxGeminiStreamingStartRequest = Readonly<{
  callControlId: string;
  streamUrl: string;
  streamAuthToken: string;
  targetLegs: TelnyxGeminiStreamingTargetLegs;
  commandId: string;
  clientState?: string;
}>;

export type TelnyxGeminiStreamingStopRequest = Readonly<{
  callControlId: string;
  commandId: string;
  streamId?: string;
  clientState?: string;
}>;

type TelnyxGeminiStreamingHost = object & {
  env?: Record<string, unknown>;
};

type FetchLike = typeof fetch;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function required(value: unknown, field: string): string {
  const normalized = nonEmpty(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function requireSecureWebSocketUrl(value: unknown): string {
  const normalized = required(value, "Gemini media stream URL");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Gemini media stream URL is invalid");
  }
  if (parsed.protocol !== "wss:") throw new Error("Gemini media stream URL must use wss://");
  return parsed.toString();
}

async function responseDetail(response: Response): Promise<string> {
  try { return (await response.text()).slice(0, 250); } catch { return ""; }
}

/**
 * Telnyx Call Control boundary for the future Gemini media plane.
 *
 * This runtime does not host media. It only asks Telnyx to connect an admitted
 * call leg to an externally-owned, authenticated WSS media edge. The media edge
 * remains outside Cloudflare Control Plane per the canonical architecture.
 */
export class TelnyxGeminiStreamingRuntime {
  private readonly fetcher: FetchLike;

  constructor(
    private readonly host: TelnyxGeminiStreamingHost,
    fetcher: FetchLike = fetch,
  ) {
    // Cloudflare native fetch is receiver-sensitive in some runtimes.
    this.fetcher = (...args) => fetcher(...args);
  }

  private apiKey(): string {
    return required(this.host.env?.TELNYX_API_KEY, "TELNYX_API_KEY");
  }

  async start(request: TelnyxGeminiStreamingStartRequest): Promise<TelnyxGeminiStreamingCommandResult> {
    try {
      const callControlId = required(request.callControlId, "Telnyx call_control_id");
      const streamUrl = requireSecureWebSocketUrl(request.streamUrl);
      const streamAuthToken = required(request.streamAuthToken, "Telnyx stream auth token");
      if (streamAuthToken.length > 4000) throw new Error("Telnyx stream auth token exceeds 4000 characters");
      const commandId = required(request.commandId, "Telnyx streaming command_id");
      if (!(["self", "opposite", "both"] as const).includes(request.targetLegs)) {
        throw new Error("Telnyx bidirectional target legs are invalid");
      }

      const body: Record<string, unknown> = {
        stream_url: streamUrl,
        stream_track: "inbound_track",
        stream_codec: "L16",
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: "L16",
        stream_bidirectional_sampling_rate: 16000,
        stream_bidirectional_target_legs: request.targetLegs,
        stream_auth_token: streamAuthToken,
        command_id: commandId,
      };
      const clientState = nonEmpty(request.clientState);
      if (clientState) body.client_state = clientState;

      const response = await this.fetcher(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/streaming_start`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey()}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (response.ok) return { ok: true, httpStatus: response.status, alreadyEnded: false };
      const detail = await responseDetail(response);
      return {
        ok: false,
        httpStatus: response.status,
        alreadyEnded: response.status === 422,
        error: `Telnyx streaming_start HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    } catch (error) {
      return { ok: false, alreadyEnded: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(request: TelnyxGeminiStreamingStopRequest): Promise<TelnyxGeminiStreamingCommandResult> {
    try {
      const callControlId = required(request.callControlId, "Telnyx call_control_id");
      const commandId = required(request.commandId, "Telnyx streaming command_id");
      const body: Record<string, unknown> = { command_id: commandId };
      const streamId = nonEmpty(request.streamId);
      const clientState = nonEmpty(request.clientState);
      if (streamId) body.stream_id = streamId;
      if (clientState) body.client_state = clientState;

      const response = await this.fetcher(
        `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/streaming_stop`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey()}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (response.ok) return { ok: true, httpStatus: response.status, alreadyEnded: false };
      const detail = await responseDetail(response);
      return {
        ok: false,
        httpStatus: response.status,
        alreadyEnded: response.status === 422,
        error: `Telnyx streaming_stop HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    } catch (error) {
      return { ok: false, alreadyEnded: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

const runtimes = new WeakMap<object, TelnyxGeminiStreamingRuntime>();

export function telnyxGeminiStreamingPortFor(host: TelnyxGeminiStreamingHost): TelnyxGeminiStreamingRuntime {
  let runtime = runtimes.get(host);
  if (!runtime) {
    runtime = new TelnyxGeminiStreamingRuntime(host);
    runtimes.set(host, runtime);
  }
  return runtime;
}
