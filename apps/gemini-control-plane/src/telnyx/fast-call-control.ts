const TELNYX_API_BASE = "https://api.telnyx.com/v2";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type TelnyxOptions = Readonly<{ apiKey: string; fetcher?: FetchLike }>;

export type FastTelnyxAnswer = Readonly<{
  callControlId: string;
  commandId: string;
}>;

export type FastTelnyxStreamingStart = Readonly<{
  callControlId: string;
  edgeUrl: string;
  streamAuthToken: string;
  commandId: string;
}>;

export type FastTelnyxMediaStart = Readonly<{
  callControlId: string;
  edgeUrl: string;
  streamAuthToken: string;
  answerCommandId: string;
  streamCommandId: string;
}>;

function required(value: unknown, field: string, max = 8_192): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function cleanEdgeUrl(value: unknown): string {
  const raw = required(value, "Fast Telnyx edge URL", 2_048);
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error("Fast Telnyx edge URL is invalid"); }
  if (parsed.protocol !== "wss:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Fast Telnyx edge URL must be a clean wss:// URL");
  }
  if (parsed.pathname !== "/telnyx/gemini") throw new Error("Fast Telnyx edge URL path is invalid");
  return parsed.toString();
}

function client(options: TelnyxOptions): Readonly<{ apiKey: string; fetcher: FetchLike }> {
  return Object.freeze({
    apiKey: required(options.apiKey, "TELNYX_API_KEY", 8_192),
    fetcher: options.fetcher ?? fetch,
  });
}

async function command(
  apiKey: string,
  callControlId: string,
  action: "answer" | "streaming_start",
  body: Record<string, unknown>,
  fetcher: FetchLike,
): Promise<void> {
  const response = await fetcher(`${TELNYX_API_BASE}/calls/${encodeURIComponent(callControlId)}/actions/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  let payload: unknown = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Telnyx ${action} failed`);
  }
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data) || (data as Record<string, unknown>).result !== "ok") {
    throw new Error(`Telnyx ${action} acknowledgement is invalid`);
  }
}

export async function answerFastGeminiTelnyxCall(input: FastTelnyxAnswer, options: TelnyxOptions): Promise<void> {
  const configured = client(options);
  const callControlId = required(input.callControlId, "Fast Telnyx call control id", 512);
  const commandId = required(input.commandId, "Fast Telnyx answer command id", 256);
  await command(configured.apiKey, callControlId, "answer", { command_id: commandId }, configured.fetcher);
}

export async function startFastGeminiTelnyxStreaming(input: FastTelnyxStreamingStart, options: TelnyxOptions): Promise<void> {
  const configured = client(options);
  const callControlId = required(input.callControlId, "Fast Telnyx call control id", 512);
  const edgeUrl = cleanEdgeUrl(input.edgeUrl);
  const streamAuthToken = required(input.streamAuthToken, "Fast Telnyx streaming auth token", 4_000);
  const commandId = required(input.commandId, "Fast Telnyx stream command id", 256);
  await command(configured.apiKey, callControlId, "streaming_start", {
    command_id: commandId,
    stream_url: edgeUrl,
    stream_track: "inbound_track",
    stream_codec: "L16",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "L16",
    stream_bidirectional_target_legs: "both",
    stream_bidirectional_sampling_rate: 16000,
    stream_auth_token: streamAuthToken,
  }, configured.fetcher);
}

/** Convenience composition used outside the latency-optimized pre-call runtime. */
export async function startFastGeminiTelnyxMedia(input: FastTelnyxMediaStart, options: TelnyxOptions): Promise<void> {
  await answerFastGeminiTelnyxCall({ callControlId: input.callControlId, commandId: input.answerCommandId }, options);
  await startFastGeminiTelnyxStreaming({
    callControlId: input.callControlId,
    edgeUrl: input.edgeUrl,
    streamAuthToken: input.streamAuthToken,
    commandId: input.streamCommandId,
  }, options);
}
