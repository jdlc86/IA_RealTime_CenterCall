export type GeminiMediaEdgeIsolatedGenerationInput = Readonly<{
  edgeUrl: string;
  tenantId: string;
  callControlId: string;
  controlPlaneToken: string;
}>;

export type GeminiMediaEdgeIsolatedGenerationRequest = Readonly<{
  instructions: string;
  inputText: string;
  maxOutputTokens?: number;
}>;

export type GeminiMediaEdgeIsolatedGenerationCapability = Readonly<{
  generate(request: GeminiMediaEdgeIsolatedGenerationRequest): Promise<string>;
  close(): void;
}>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function endpoint(edgeUrl: string): string {
  let edge: URL;
  try { edge = new URL(required(edgeUrl, "Gemini media edge URL")); }
  catch { throw new Error("Gemini media edge URL is invalid"); }
  if (edge.protocol !== "wss:") throw new Error("Gemini media edge URL must use wss://");
  if (edge.username || edge.password) throw new Error("Gemini media edge URL must not contain credentials");
  edge.protocol = "https:";
  edge.pathname = "/internal/isolated-generation";
  edge.search = "";
  edge.hash = "";
  return edge.toString();
}

function generatedText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Gemini isolated generation returned no text");
  return value.trim().slice(0, 5000);
}

export function createGeminiMediaEdgeIsolatedGenerationCapability(
  input: GeminiMediaEdgeIsolatedGenerationInput,
  fetcher: typeof fetch = fetch,
): GeminiMediaEdgeIsolatedGenerationCapability {
  const url = endpoint(input.edgeUrl);
  const tenantId = required(input.tenantId, "Gemini media edge tenant_id");
  const callControlId = required(input.callControlId, "Gemini media edge call_control_id");
  const token = required(input.controlPlaneToken, "Gemini media edge control-plane token");
  if (typeof fetcher !== "function") throw new Error("Gemini isolated generation fetcher is required");

  let active = true;

  return Object.freeze({
    async generate(request: GeminiMediaEdgeIsolatedGenerationRequest): Promise<string> {
      if (!active) throw new Error("Gemini isolated generation capability is closed");
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
        },
        body: JSON.stringify({
          tenantId,
          callControlId,
          instructions: required(request.instructions, "Gemini isolated generation instructions"),
          inputText: required(request.inputText, "Gemini isolated generation input"),
          ...(request.maxOutputTokens == null ? {} : { maxOutputTokens: request.maxOutputTokens }),
        }),
      });
      if (!active) throw new Error("Gemini isolated generation capability is closed");
      if (!response.ok) throw new Error(`Gemini isolated generation endpoint failed with HTTP ${response.status}`);
      const payload = await response.json() as { ok?: unknown; text?: unknown };
      if (payload.ok !== true) throw new Error("Gemini isolated generation endpoint rejected request");
      return generatedText(payload.text);
    },
    close() { active = false; },
  });
}
