function required(value, field, max = 16_384) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function canonicalSinkUrl(value) {
  const parsed = new URL(required(value, "FAST_DIAGNOSTIC_SINK_URL", 2_048));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("FAST_DIAGNOSTIC_SINK_URL is invalid");
  }
  return parsed.toString();
}

// Post-call, best-effort telemetry only. This module must never be awaited by the live audio path.
export function createFastDiagnosticFlusher(options = {}) {
  const sinkUrl = canonicalSinkUrl(options.sinkUrl);
  const controlToken = required(options.controlToken, "MEDIA_EDGE_CONTROL_PLANE_TOKEN");
  const fetcher = options.fetcher ?? fetch;
  if (typeof fetcher !== "function") throw new Error("Fast diagnostic fetcher is required");

  return async function flushFastDiagnostics(events) {
    if (!Array.isArray(events) || events.length < 1 || events.length > 64) throw new Error("Fast diagnostic batch is invalid");
    const response = await fetcher(sinkUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Fast diagnostic sink rejected batch with HTTP ${response.status}`);
  };
}
