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
    "Use the tool catalog as the product contract. Classify the semantic route only; do not invent arguments or decide whether the backend can complete the operation yet.",
    "Treat a tool that explicitly supports create-or-continue, progressive, partial, draft, or multi-turn collection as the operation route: select that tool as soon as the caller starts or continues that operation, even when the current turn omits fields.",
    "Missing inputs for a progressive or multi-turn operation are not a reason to route to restaurant_conversation; the backend owns missing-information collection and authoritative completion.",
    "Use restaurant_conversation only for ordinary dialogue that is not semantically owned by an existing operation, data, action, escalation, security, ignore, or end-call tool.",
    "JSON Schema required fields describe provider argument syntax. Never use them as a semantic readiness gate and never let them override progressive or multi-turn behavior stated by the tool contract.",
    "A short follow-up that continues an active operation belongs to that operation tool rather than restaurant_conversation when the supplied context makes that ownership clear.",
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
