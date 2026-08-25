const PROBE_TOOL = "restaurant_conversation";

function safeFailureCategory(error) {
  const message = error instanceof Error ? error.message : "";
  const http = message.match(/request failed with HTTP (\d{3})/);
  if (http) return `PROVIDER_HTTP_${http[1]}`;
  if (message.includes("request failed")) return "PROVIDER_TRANSPORT";
  if (message.includes("response is invalid JSON")) return "PROVIDER_RESPONSE_INVALID_JSON";
  if (message.includes("returned no text")) return "PROVIDER_RESPONSE_EMPTY";
  if (message.includes("semantic readiness response")) return "PROBE_RESPONSE_INVALID";
  if (message.includes("required") || message.includes("invalid")) return "PROBE_REQUEST_INVALID";
  return "UNKNOWN";
}

function validateProbeResponse(text) {
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error("Gemini semantic readiness response is invalid"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Gemini semantic readiness response is invalid");
  if (Object.keys(payload).length !== 1 || payload.selectedTool !== PROBE_TOOL) throw new Error("Gemini semantic readiness response is invalid");
}

export function semanticDecisionFailureCategory(error) {
  return safeFailureCategory(error);
}

export async function runSemanticDecisionReadinessProbe(client) {
  if (!client || typeof client.decide !== "function") {
    return Object.freeze({ status: "failed", failureCategory: "PROBE_REQUEST_INVALID" });
  }
  try {
    const text = await client.decide({
      instructions: `Classify the fixed synthetic input. Return JSON only. selectedTool must be exactly ${PROBE_TOOL}.`,
      inputText: "hola",
      maxOutputTokens: 32,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["selectedTool"],
        properties: {
          selectedTool: { type: "string", enum: [PROBE_TOOL] },
        },
      },
    });
    validateProbeResponse(text);
    return Object.freeze({ status: "ready" });
  } catch (error) {
    return Object.freeze({ status: "failed", failureCategory: safeFailureCategory(error) });
  }
}
