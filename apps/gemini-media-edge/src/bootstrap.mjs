function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
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
    description: tool.description,
    parameters: structuredClone(tool.parameters),
  }));
  return Object.freeze({
    setup: {
      model: required(model, "Gemini Live model"),
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
    if (this.entries.has(bootstrap.credentialId)) throw new Error("Gemini media edge bootstrap already registered");
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
