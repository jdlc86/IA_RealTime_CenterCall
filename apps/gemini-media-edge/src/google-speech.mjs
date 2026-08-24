const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function segment(value, field) {
  const normalized = required(value, field);
  if (normalized.includes("/") || normalized.includes("?") || normalized.includes("#")) throw new Error(`${field} is invalid`);
  return normalized;
}

function decodePcm16LittleEndianPayload(payload) {
  const normalized = required(payload, "Google Speech audio payload");
  let bytes;
  try { bytes = Buffer.from(normalized, "base64"); } catch { throw new Error("Google Speech audio payload is invalid"); }
  if (bytes.length === 0 || bytes.length % 2 !== 0) throw new Error("Google Speech requires complete PCM16 samples");
  return bytes;
}

function transcriptFromResponse(value) {
  const parts = [];
  for (const result of value?.results ?? []) {
    const transcript = result?.alternatives?.[0]?.transcript;
    if (typeof transcript !== "string") continue;
    const normalized = transcript.replace(/\s+/g, " ").trim();
    if (normalized) parts.push(normalized);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Cloud Run service-identity OAuth token provider with bounded in-memory cache. */
export function createCloudRunAccessTokenProvider(fetcher = fetch, now = () => Date.now()) {
  let cached = null;
  return async function accessToken() {
    const current = now();
    if (cached && current < cached.refreshAfterEpochMs) return cached.token;
    let response;
    try {
      response = await fetcher(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
    } catch {
      throw new Error("Cloud Run service identity token acquisition failed");
    }
    if (!response.ok) throw new Error(`Cloud Run service identity token acquisition failed with HTTP ${response.status}`);
    let payload;
    try { payload = await response.json(); } catch { throw new Error("Cloud Run service identity token response is invalid"); }
    const token = required(payload?.access_token, "Cloud Run service identity access token");
    const expiresInSeconds = Number(payload?.expires_in);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) throw new Error("Cloud Run service identity token expiry is invalid");
    const lifetimeMs = Math.floor(expiresInSeconds * 1000);
    const safetyMs = Math.min(60_000, Math.max(1_000, Math.floor(lifetimeMs / 10)));
    cached = Object.freeze({ token, refreshAfterEpochMs: current + Math.max(1_000, lifetimeMs - safetyMs) });
    return token;
  };
}

/**
 * Google Speech-to-Text v2 adapter for one completed Telnyx caller candidate.
 * Input is exact Telnyx WebSocket L16/PCM16 little-endian 16 kHz mono. Google
 * LINEAR16 accepts the same byte order, so samples are forwarded unchanged.
 */
export function createGoogleSpeechV2Transcriber(options) {
  const projectId = segment(options?.projectId, "GOOGLE_CLOUD_PROJECT_ID");
  const location = segment(options?.location ?? "global", "GOOGLE_SPEECH_LOCATION");
  const recognizer = segment(options?.recognizer ?? "_", "GOOGLE_SPEECH_RECOGNIZER");
  // The implicit recognizer (`_`) currently rejects requests whose inline
  // RecognitionConfig omits model, despite the REST field being documented as
  // optional. This edge handles short telephone turns, so keep the compatible
  // telephony model explicit and deterministic.
  const model = segment(options?.model ?? "telephony_short", "GOOGLE_SPEECH_MODEL");
  const languageCodes = Array.isArray(options?.languageCodes)
    ? options.languageCodes.map((value) => required(value, "Google Speech language code"))
    : [];
  if (!languageCodes.length || new Set(languageCodes).size !== languageCodes.length) throw new Error("Google Speech language codes are invalid");
  if (typeof options?.accessTokenProvider !== "function") throw new Error("Google Speech access token provider is required");
  const fetcher = options.fetcher ?? fetch;

  return async function transcribe(request) {
    const itemId = required(request?.itemId, "Google Speech caller item id");
    if (!Array.isArray(request?.payloads) || request.payloads.length === 0) throw new Error("Google Speech requires buffered caller audio");
    const content = Buffer.concat(request.payloads.map(decodePcm16LittleEndianPayload)).toString("base64");
    let token;
    try { token = required(await options.accessTokenProvider(), "Google Speech access token"); }
    catch { throw new Error("Google Speech access token acquisition failed"); }
    const config = {
      explicitDecodingConfig: { encoding: "LINEAR16", sampleRateHertz: 16_000, audioChannelCount: 1 },
      languageCodes,
      model,
    };
    const endpoint = `https://speech.googleapis.com/v2/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/recognizers/${encodeURIComponent(recognizer)}:recognize`;
    let response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ config, content }),
      });
    } catch {
      throw new Error("Google Speech recognition request failed");
    }
    if (!response.ok) throw new Error(`Google Speech recognition failed with HTTP ${response.status}`);
    let payload;
    try { payload = await response.json(); } catch { throw new Error("Google Speech recognition response is invalid"); }
    const transcript = transcriptFromResponse(payload);
    if (!transcript) throw new Error("Google Speech returned no transcript");
    return Object.freeze({ itemId, transcript });
  };
}
