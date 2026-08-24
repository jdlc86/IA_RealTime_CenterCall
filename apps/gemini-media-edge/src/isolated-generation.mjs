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

function boundedText(value, field, maxChars) {
  const text = required(value, field);
  if (text.length > maxChars) throw new Error(`${field} exceeds the configured limit`);
  return text;
}

function responseText(value, maxOutputChars) {
  const candidates = Array.isArray(value?.candidates) ? value.candidates : [];
  const parts = candidates.flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []);
  const text = parts.map((part) => typeof part?.text === "string" ? part.text : "").join("").trim();
  if (!text) throw new Error("Gemini isolated generation returned no text");
  if (text.length > maxOutputChars) throw new Error("Gemini isolated generation output exceeds the configured limit");
  return text;
}

/**
 * One-shot text generation that is deliberately independent from Gemini Live.
 * It is intended for product-owned governed speech wording that cannot be a
 * fixed exactText. No generated text is inserted into Live conversation history.
 */
export function createGeminiIsolatedGenerationClient(options = {}) {
  const apiKey = required(options.apiKey, "GEMINI_API_KEY");
  const model = required(options.model ?? "gemini-2.5-flash-lite", "GEMINI_GENERATION_MODEL");
  const fetcher = options.fetcher ?? fetch;
  if (typeof fetcher !== "function") throw new Error("Gemini isolated generation fetcher is required");
  const maxInputChars = boundedPositiveInteger(options.maxInputChars, "Gemini isolated generation input limit", 4_000, 20_000);
  const maxOutputChars = boundedPositiveInteger(options.maxOutputChars, "Gemini isolated generation output limit", 1_500, 5_000);

  return Object.freeze({
    async generate(request) {
      const instructions = boundedText(request?.instructions, "Gemini isolated generation instructions", maxInputChars);
      const inputText = boundedText(request?.inputText, "Gemini isolated generation input", maxInputChars);
      const maxOutputTokens = boundedPositiveInteger(request?.maxOutputTokens, "Gemini isolated generation maxOutputTokens", 96, 512);
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
              temperature: 0.2,
              maxOutputTokens,
              responseMimeType: "text/plain",
            },
          }),
        });
      } catch {
        throw new Error("Gemini isolated generation request failed");
      }
      if (!response?.ok) throw new Error(`Gemini isolated generation request failed with HTTP ${response?.status ?? "unknown"}`);
      let payload;
      try { payload = await response.json(); }
      catch { throw new Error("Gemini isolated generation response is invalid JSON"); }
      return responseText(payload, maxOutputChars);
    },
  });
}

/**
 * Executes isolated wording only while the exact tenant/call session is active.
 * This mirrors the auxiliary decision boundary and prevents cross-call use.
 */
export async function generateForActiveGeminiControlSession(controlRegistry, client, value) {
  if (!controlRegistry || typeof controlRegistry.isActive !== "function") throw new Error("Gemini control session registry is required");
  if (!client || typeof client.generate !== "function") throw new Error("Gemini isolated generation client is required");
  const tenantId = required(value?.tenantId, "Gemini isolated generation tenant_id");
  const callControlId = required(value?.callControlId, "Gemini isolated generation call_control_id");
  const claims = Object.freeze({ tenantId, callControlId });
  if (controlRegistry.isActive(claims) !== true) {
    throw new Error("Gemini isolated generation requires an active control session");
  }
  return client.generate({
    instructions: value?.instructions,
    inputText: value?.inputText,
    maxOutputTokens: value?.maxOutputTokens,
  });
}
