function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

const DIRECT_MODEL_OUTPUT_TOOLS = new Set(["restaurant_conversation"]);

function semanticTools(bootstrap) {
  const tools = Array.isArray(bootstrap?.tools) ? bootstrap.tools : [];
  if (!tools.length) throw new Error("Gemini semantic preselection requires bootstrap tools");
  const seen = new Set();
  const result = [];
  for (const tool of tools) {
    const name = required(tool?.name, "Gemini semantic preselection tool name");
    const description = required(tool?.description, `Gemini semantic preselection tool ${name} description`);
    if (seen.has(name)) throw new Error(`Gemini semantic preselection tool ${name} is duplicated`);
    seen.add(name);
    result.push(Object.freeze({ name, description }));
  }
  return Object.freeze(result);
}

export function buildSemanticPreselectionRequest(bootstrap, transcript) {
  const inputText = required(transcript, "Gemini semantic preselection transcript").slice(0, 1500);
  const tools = semanticTools(bootstrap);
  const catalog = tools.map((tool) => `${tool.name}: ${tool.description}`).join("\n");
  const allowed = tools.map((tool) => tool.name).join(", ");
  const instructions = [
    "Classify the caller turn into exactly one existing restaurant tool.",
    "Return only the exact tool name, with no JSON, punctuation, markdown or explanation.",
    "Use restaurant_conversation when the assistant must ask a follow-up or continue ordinary dialogue before an authoritative business action can execute.",
    "Choose an action/data tool only when the current caller turn itself contains enough information to require that governed tool path.",
    `Allowed tool names: ${allowed}`,
    "Tool catalog:",
    catalog,
  ].join("\n");
  return Object.freeze({ instructions, inputText, maxOutputTokens: 32, allowedToolNames: Object.freeze(tools.map((tool) => tool.name)) });
}

export function parseSemanticPreselection(text, allowedToolNames) {
  const selectedTool = required(text, "Gemini semantic preselection result");
  const allowed = new Set(Array.isArray(allowedToolNames) ? allowedToolNames : []);
  if (!allowed.has(selectedTool)) throw new Error("Gemini semantic preselection returned an unsupported tool");
  return Object.freeze({
    selectedTool,
    directModelOutputAllowed: DIRECT_MODEL_OUTPUT_TOOLS.has(selectedTool),
  });
}

export async function resolveSemanticPreselection(decide, bootstrap, transcript) {
  if (typeof decide !== "function") throw new Error("Gemini semantic preselection decision function is required");
  const request = buildSemanticPreselectionRequest(bootstrap, transcript);
  const text = await decide({
    instructions: request.instructions,
    inputText: request.inputText,
    maxOutputTokens: request.maxOutputTokens,
  });
  return parseSemanticPreselection(text, request.allowedToolNames);
}
