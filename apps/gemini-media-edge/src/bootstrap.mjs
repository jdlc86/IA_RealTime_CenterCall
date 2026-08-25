function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

const GEMINI_TOOL_DESCRIPTION_SUFFIXES = Object.freeze({
  restaurant_reservation_create: "Gemini Live compatibility: this is a progressive multi-turn operation. Invoke it as soon as the caller starts or continues a reservation, even when date, time, party size, name, contact or confirmation are still missing; the backend reports missing information and remains the only authority for completion.",
});

function modelResourceName(value) {
  const model = required(value, "Gemini Live model");
  const identifier = model.startsWith("models/") ? model.slice("models/".length) : model;
  if (!/^[A-Za-z0-9._-]+$/.test(identifier)) {
    throw new Error("Gemini Live model resource name is invalid");
  }
  return `models/${identifier}`;
}

function geminiParametersJsonSchema(value) {
  if (Array.isArray(value)) return value.map(geminiParametersJsonSchema);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    // Gemini's FunctionDeclaration JSON-schema subset does not expose
    // uniqueItems. The backend remains the authority that validates tool
    // arguments, so dropping this model hint cannot authorize an effect.
    if (key === "uniqueItems") continue;
    result[key] = geminiParametersJsonSchema(item);
  }
  return result;
}

function geminiToolDescription(tool) {
  const suffix = GEMINI_TOOL_DESCRIPTION_SUFFIXES[tool.name];
  return suffix ? `${tool.description} ${suffix}` : tool.description;
}

function safeEpoch(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function canonicalTools(value) {
  if (!Array.isArray(value)) throw new Error("Gemini media edge bootstrap tools must be an array");
  return Object.freeze(value.map((tool, index) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool) || tool.type !== "function") {
      throw new Error(`Gemini media edge bootstrap tool ${index} is invalid`);
    }
    const name = required(tool.name, `Gemini media edge bootstrap tool ${index} name`);
    const description = required(tool.description, `Gemini media edge bootstrap tool ${index} description`);
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw new Error(`Gemini media edge bootstrap tool ${index} parameters are invalid`);
    }
    return Object.freeze({ type: "function", name, description, parameters: structuredClone(tool.parameters) });
  }));
}

export function canonicalBootstrap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gemini media edge bootstrap is invalid");
  }
  if (value.manualActivityDetection !== true) {
    throw new Error("Gemini media edge bootstrap requires manual activity detection");
  }
  if (value.manualActivityHandling !== "START_OF_ACTIVITY_INTERRUPTS") {
    throw new Error("Gemini media edge bootstrap requires START_OF_ACTIVITY_INTERRUPTS");
  }
  return Object.freeze({
    credentialId: required(value.credentialId, "Gemini media edge bootstrap credential id"),
    tenantId: required(value.tenantId, "Gemini media edge bootstrap tenant_id"),
    callControlId: required(value.callControlId, "Gemini media edge bootstrap call_control_id"),
    notAfterEpochMs: safeEpoch(value.notAfterEpochMs, "Gemini media edge bootstrap notAfterEpochMs"),
    instructions: required(value.instructions, "Gemini media edge bootstrap instructions"),
    tools: canonicalTools(value.tools),
    manualActivityDetection: true,
    manualActivityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  });
}

export function buildGeminiInitialSetup(bootstrap, model) {
  const value = canonicalBootstrap(bootstrap);
  const declarations = value.tools.map((tool) => ({
    name: tool.name,
    description: geminiToolDescription(tool),
    behavior: "BLOCKING",
    parametersJsonSchema: geminiParametersJsonSchema(tool.parameters),
  }));
  return Object.freeze({
    setup: {
      model: modelResourceName(model),
      systemInstruction: { parts: [{ text: value.instructions }] },
      tools: [{ functionDeclarations: declarations }],
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
        activityHandling: value.manualActivityHandling,
      },
    },
  });
}

export function isGeminiSetupComplete(message) {
  return Boolean(message && typeof message === "object" && !Array.isArray(message)
    && (message.setupComplete !== undefined || message.setup_complete !== undefined));
}

/** Single-instance bootstrap store used by the first Cloud Run canary topology. */
export class InMemoryBootstrapRegistry {
  constructor() { this.entries = new Map(); }

  register(input, nowEpochMs = Date.now()) {
    const bootstrap = canonicalBootstrap(input);
    const now = safeEpoch(nowEpochMs, "Gemini media edge bootstrap nowEpochMs");
    if (now >= bootstrap.notAfterEpochMs) throw new Error("Gemini media edge bootstrap expired");
    this.prune(now);
    const existing = this.entries.get(bootstrap.credentialId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(bootstrap)) {
        throw new Error("Gemini media edge bootstrap already registered with different content");
      }
      return existing;
    }
    this.entries.set(bootstrap.credentialId, bootstrap);
    return bootstrap;
  }

  consumeForClaims(claims, nowEpochMs = Date.now()) {
    const now = safeEpoch(nowEpochMs, "Gemini media edge bootstrap consume nowEpochMs");
    this.prune(now);
    const credentialId = required(claims?.credentialId, "Gemini media edge credential id");
    const bootstrap = this.entries.get(credentialId);
    if (!bootstrap) throw new Error("Gemini media edge bootstrap is not registered");
    if (bootstrap.tenantId !== claims.tenantId || bootstrap.callControlId !== claims.callControlId) {
      throw new Error("Gemini media edge bootstrap identity does not match credential");
    }
    if (bootstrap.notAfterEpochMs !== claims.notAfterEpochMs) {
      throw new Error("Gemini media edge bootstrap expiry does not match credential");
    }
    this.entries.delete(credentialId);
    return bootstrap;
  }

  prune(nowEpochMs = Date.now()) {
    const now = safeEpoch(nowEpochMs, "Gemini media edge bootstrap prune nowEpochMs");
    for (const [id, value] of this.entries) if (now >= value.notAfterEpochMs) this.entries.delete(id);
  }

  size() { return this.entries.size; }
}
