function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

const DIRECT_MODEL_OUTPUT_TOOLS = new Set(["restaurant_conversation"]);

function requiredInputs(parameters) {
  const values = Array.isArray(parameters?.required) ? parameters.required : [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = value.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return Object.freeze(result);
}

function inputFields(parameters) {
  const properties = parameters?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return Object.freeze([]);
  const seen = new Set();
  const result = [];
  for (const value of Object.keys(properties)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = value.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return Object.freeze(result);
}

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
    result.push(Object.freeze({
      name,
      description,
      requiredInputs: requiredInputs(tool?.parameters),
      inputFields: inputFields(tool?.parameters),
    }));
  }
  return Object.freeze(result);
}

export function buildSemanticPreselectionRequest(bootstrap, transcript) {
  const inputText = required(transcript, "Gemini semantic preselection transcript").slice(0, 1500);
  const tools = semanticTools(bootstrap);
  const allowedToolNames = Object.freeze(tools.map((tool) => tool.name));
  const catalog = tools.map((tool) => {
    const requiredSuffix = tool.requiredInputs.length
      ? ` Declared required inputs: ${tool.requiredInputs.join(", ")}.`
      : " Declared required inputs: none.";
    const inputSuffix = tool.inputFields.length
      ? ` Available input fields: ${tool.inputFields.join(", ")}.`
      : "";
    return `${tool.name}: ${tool.description}${requiredSuffix}${inputSuffix}`;
  }).join("\n");
  const allowed = allowedToolNames.join(", ");
  const instructions = [
    "Classify the caller turn into exactly one existing restaurant tool.",
    "The response is schema-constrained; choose exactly one allowed tool and do not invent tool names.",
    "Use restaurant_conversation whenever the assistant must ask a follow-up or continue ordinary dialogue before an authoritative business action can execute.",
    "Choose an action/data tool only when the current caller turn itself contains enough information to execute that governed tool without first asking a follow-up.",
    "JSON Schema required fields are only a syntactic hint. Missing or empty required fields never mean that an intent-only turn is semantically ready to execute a governed tool.",
    "Obey every prerequisite and qualifier stated in each tool description even when the JSON Schema accepts partial arguments.",
    "If the current caller turn only expresses intent to start an operation but lacks a prerequisite described by that tool, select restaurant_conversation so the assistant may ask the next question.",
    "A governed tool that supports progressive or partial arguments must not be preselected merely because its schema accepts an incomplete object.",
    "If a governed tool has declared required inputs that are not supplied by the current caller turn, choose restaurant_conversation.",
    `Allowed tool names: ${allowed}`,
    "Tool catalog:",
    catalog,
  ].join("\n");
  return Object.freeze({
    instructions,
    inputText,
    maxOutputTokens: 64,
    allowedToolNames,
    responseMimeType: "application/json",
    responseJsonSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        selectedTool: Object.freeze({ type: "string", enum: allowedToolNames }),
      }),
      required: Object.freeze(["selectedTool"]),
      additionalProperties: false,
    }),
  });
}

export function parseSemanticPreselection(text, allowedToolNames) {
  const raw = required(text, "Gemini semantic preselection result");
  let payload;
  try { payload = JSON.parse(raw); }
  catch { throw new Error("Gemini semantic preselection returned invalid structured output"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Gemini semantic preselection returned invalid structured output");
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "selectedTool") {
    throw new Error("Gemini semantic preselection returned invalid structured output");
  }
  const selectedTool = required(payload.selectedTool, "Gemini semantic preselection selectedTool");
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
    responseMimeType: request.responseMimeType,
    responseJsonSchema: request.responseJsonSchema,
  });
  return parseSemanticPreselection(text, request.allowedToolNames);
}
