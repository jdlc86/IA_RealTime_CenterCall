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
              responseMimeType: "text/plain",
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
