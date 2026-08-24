function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function segment(value, field) {
  const normalized = required(value, field);
  if (normalized.includes("/") || normalized.includes("?") || normalized.includes("#")) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function boundedText(value, maxChars) {
  if (typeof value !== "string") throw new Error("Google Text-to-Speech text is required");
  const text = value.trim();
  if (!text) throw new Error("Google Text-to-Speech text is required");
  if (text.length > maxChars) throw new Error("Google Text-to-Speech text exceeds the configured limit");
  return text;
}

function decodePcmAudio(value, maxAudioBytes) {
  const encoded = required(value, "Google Text-to-Speech audio content");
  let bytes;
  try { bytes = Buffer.from(encoded, "base64"); }
  catch { throw new Error("Google Text-to-Speech audio content is invalid"); }
  if (bytes.length === 0 || bytes.length % 2 !== 0) {
    throw new Error("Google Text-to-Speech returned invalid PCM16 audio");
  }
  if (bytes.length > maxAudioBytes) throw new Error("Google Text-to-Speech audio exceeds the configured limit");
  return bytes;
}

/**
 * One-shot governed speech synthesizer for the Gemini media edge.
 *
 * This adapter is deliberately independent of Gemini Live. It sends the exact
 * product-owned text to Cloud Text-to-Speech and requests raw, headerless PCM16
 * little-endian at 16 kHz. The caller decides how that audio is correlated and
 * delivered to telephony; no conversational user/model turn is manufactured here.
 */
export function createGoogleTextToSpeechSynthesizer(options) {
  const projectId = segment(options?.projectId, "GOOGLE_CLOUD_PROJECT_ID");
  const languageCode = required(options?.languageCode, "GOOGLE_TTS_LANGUAGE_CODE");
  const voiceName = required(options?.voiceName, "GOOGLE_TTS_VOICE_NAME");
  if (typeof options?.accessTokenProvider !== "function") throw new Error("Google Text-to-Speech access token provider is required");
  const fetcher = options.fetcher ?? fetch;
  const maxTextChars = Number(options.maxTextChars ?? 2_000);
  const maxAudioBytes = Number(options.maxAudioBytes ?? 4 * 1024 * 1024);
  if (!Number.isSafeInteger(maxTextChars) || maxTextChars < 1 || maxTextChars > 10_000) {
    throw new Error("Google Text-to-Speech text limit is invalid");
  }
  if (!Number.isSafeInteger(maxAudioBytes) || maxAudioBytes < 2 || maxAudioBytes > 16 * 1024 * 1024) {
    throw new Error("Google Text-to-Speech audio limit is invalid");
  }

  return async function synthesize(request) {
    const text = boundedText(request?.text, maxTextChars);
    let token;
    try { token = required(await options.accessTokenProvider(), "Google Text-to-Speech access token"); }
    catch { throw new Error("Google Text-to-Speech access token acquisition failed"); }

    let response;
    try {
      response = await fetcher("https://texttospeech.googleapis.com/v1/text:synthesize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "x-goog-user-project": projectId,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode, name: voiceName },
          audioConfig: { audioEncoding: "PCM", sampleRateHertz: 16_000 },
        }),
      });
    } catch {
      throw new Error("Google Text-to-Speech synthesis request failed");
    }
    if (!response.ok) throw new Error(`Google Text-to-Speech synthesis failed with HTTP ${response.status}`);

    let payload;
    try { payload = await response.json(); }
    catch { throw new Error("Google Text-to-Speech synthesis response is invalid"); }
    const pcm16le = decodePcmAudio(payload?.audioContent, maxAudioBytes);
    return Object.freeze({ text, pcm16le, sampleRateHertz: 16_000, encoding: "PCM16_LE" });
  };
}
