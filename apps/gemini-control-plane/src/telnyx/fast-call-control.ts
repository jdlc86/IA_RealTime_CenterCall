const TELNYX_API_BASE = "https://api.telnyx.com/v2";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

/**
 * Establishes the audio-only fast path with the minimum two Telnyx commands.
 * Telnyx requires answer before later commands. streaming_start is separate
 * because stream_auth_token is available there and binds the WebSocket to the
 * pre-provisioned fast-media admission.
 */
export async function startFastGeminiTelnyxMedia(
  input: FastTelnyxMediaStart,
  options: Readonly<{ apiKey: string; fetcher?: FetchLike }>,
): Promise<void> {
  const apiKey = required(options.apiKey, "TELNYX_API_KEY", 8_192);
  const callControlId = required(input.callControlId, "Fast Telnyx call control id", 512);
  const edgeUrl = cleanEdgeUrl(input.edgeUrl);
  const streamAuthToken = required(input.streamAuthToken, "Fast Telnyx streaming auth token", 4_000);
  const answerCommandId = required(input.answerCommandId, "Fast Telnyx answer command id", 256);
  const streamCommandId = required(input.streamCommandId, "Fast Telnyx stream command id", 256);
  const fetcher = options.fetcher ?? fetch;

  await command(apiKey, callControlId, "answer", { command_id: answerCommandId }, fetcher);
  await command(apiKey, callControlId, "streaming_start", {
    command_id: streamCommandId,
    stream_url: edgeUrl,
    stream_track: "inbound_track",
    stream_codec: "L16",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "L16",
    stream_bidirectional_target_legs: "both",
    stream_bidirectional_sampling_rate: 16000,
    stream_auth_token: streamAuthToken,
  }, fetcher);
}
