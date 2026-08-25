function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function boundedPositiveInteger(value, field, fallback, max) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > max) throw new Error(`${field} is invalid`);
  return number;
}

function optionalStructuredResponse(request) {
  const mime = request?.responseMimeType;
  const schema = request?.responseJsonSchema;
  if (mime == null && schema == null) return Object.freeze({ responseMimeType: "text/plain" });
  const responseMimeType = required(mime, "Gemini isolated decision responseMimeType");
  if (responseMimeType !== "application/json") throw new Error("Gemini isolated decision responseMimeType is invalid");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Gemini isolated decision responseJsonSchema is invalid");
  }
  let encoded;
  try { encoded = JSON.stringify(schema); }
  catch { throw new Error("Gemini isolated decision responseJsonSchema is invalid"); }
  if (!encoded || Buffer.byteLength(encoded, "utf8") > 8_192) {
    throw new Error("Gemini isolated decision responseJsonSchema is invalid");
  }
  return Object.freeze({ responseMimeType, responseJsonSchema: JSON.parse(encoded) });
}

function responseText(value) {
  const candidates = Array.isArray(value?.candidates) ? value.candidates : [];
  const parts = candidates.flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []);
  const text = parts.map((part) => typeof part?.text === "string" ? part.text : "").join("").trim();
  if (!text) throw new Error("Gemini isolated decision returned no text");
  return text;
}

/**
 * Creates a text-only Gemini classifier that is intentionally independent from
 * the Live media session. The caller transcript is ordinary request content for
 * this one-shot model invocation and can never become Live conversation history,
 * audio, playback or tool state.
 */
export function createGeminiIsolatedDecisionClient(options = {}) {
  const apiKey = required(options.apiKey, "GEMINI_API_KEY");
  const model = required(options.model ?? "gemini-2.5-flash-lite", "GEMINI_DECISION_MODEL");
  const fetcher = options.fetcher ?? fetch;
  if (typeof fetcher !== "function") throw new Error("Gemini isolated decision fetcher is required");

  return Object.freeze({
    async decide(request) {
      const instructions = required(request?.instructions, "Gemini isolated decision instructions");
      const inputText = required(request?.inputText, "Gemini isolated decision input");
      const maxOutputTokens = boundedPositiveInteger(request?.maxOutputTokens, "Gemini isolated decision maxOutputTokens", 16, 256);
      const structured = optionalStructuredResponse(request);
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      let response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Accept: "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: instructions }] },
            contents: [{ role: "user", parts: [{ text: inputText }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens,
              responseMimeType: structured.responseMimeType,
              ...(structured.responseJsonSchema ? { responseJsonSchema: structured.responseJsonSchema } : {}),
            },
          }),
        });
      } catch {
        throw new Error("Gemini isolated decision request failed");
      }
      if (!response?.ok) throw new Error(`Gemini isolated decision request failed with HTTP ${response?.status ?? "unknown"}`);
      let payload;
      try { payload = await response.json(); }
      catch { throw new Error("Gemini isolated decision response is invalid JSON"); }
      return responseText(payload);
    },
  });
}

/**
 * Executes an auxiliary decision only while the exact tenant/call control session
 * is actively attached to the media edge. This prevents the shared control-plane
 * credential from becoming a cross-call classifier oracle.
 */
export async function decideForActiveGeminiControlSession(controlRegistry, client, value) {
  if (!controlRegistry || typeof controlRegistry.isActive !== "function") throw new Error("Gemini control session registry is required");
  if (!client || typeof client.decide !== "function") throw new Error("Gemini isolated decision client is required");
  const tenantId = required(value?.tenantId, "Gemini isolated decision tenant_id");
  const callControlId = required(value?.callControlId, "Gemini isolated decision call_control_id");
  const claims = Object.freeze({ tenantId, callControlId });
  if (controlRegistry.isActive(claims) !== true) {
    throw new Error("Gemini isolated decision requires an active control session");
  }
  return client.decide({
    instructions: value?.instructions,
    inputText: value?.inputText,
    maxOutputTokens: value?.maxOutputTokens,
    responseMimeType: value?.responseMimeType,
    responseJsonSchema: value?.responseJsonSchema,
  });
}
