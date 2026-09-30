import { buildFastToolAuthorityContract } from "./fast-tool-authorization-kernel.mjs";

const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_VOICE = "Kore";
const DEFAULT_LANGUAGE = "es-ES";
const DEFAULT_INPUT_RATE_HZ = 16_000;

function requiredString(value, field, max = 16_384) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\r\n\t]/.test(field) || /[\u0000]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function safeInteger(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${field} is invalid`);
  return value;
}

function modelResourceName(value) {
  const model = requiredString(value ?? DEFAULT_MODEL, "Gemini model", 160);
  const identifier = model.startsWith("models/") ? model.slice("models/".length) : model;
  if (!/^[A-Za-z0-9._-]+$/.test(identifier)) throw new Error("Gemini model resource is invalid");
  return `models/${identifier}`;
}

function canonicalToolPolicies(value) {
  if (value == null) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini tool policies are invalid");
  return value;
}

function canonicalTool(tool, index, toolPolicies) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error(`Gemini tool ${index} is invalid`);
  const name = requiredString(tool.name, `Gemini tool ${index} name`, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Gemini tool ${index} name is invalid`);
  const description = requiredString(tool.description, `Gemini tool ${index} description`, 4_000);
  if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
    throw new Error(`Gemini tool ${index} parameters are invalid`);
  }
  const policy = toolPolicies[name];
  if (!policy) throw new Error(`Gemini tool policy required: ${name}`);
  const grantedCapability = requiredString(tool.capability, `Gemini tool ${index} capability`, 128);
  if (grantedCapability !== policy.capability) throw new Error(`Gemini tool capability mismatch: ${name}`);
  const contract = buildFastToolAuthorityContract(description, tool.parameters, policy);
  return Object.freeze({
    name,
    description: contract.description,
    parametersJsonSchema: contract.parametersJsonSchema,
    behavior: "BLOCKING",
  });
}

export function buildFastGemini31Setup(options = {}) {
  const instruction = requiredString(options.systemInstruction, "Gemini system instruction", 64_000);
  const voiceName = requiredString(options.voiceName ?? DEFAULT_VOICE, "Gemini voice name", 128);
  const languageCode = requiredString(options.languageCode ?? DEFAULT_LANGUAGE, "Gemini language code", 32);
  const toolPolicies = canonicalToolPolicies(options.toolPolicies);
  const tools = Array.isArray(options.tools) ? options.tools.map((tool, index) => canonicalTool(tool, index, toolPolicies)) : [];
  const prefixPaddingMs = safeInteger(options.prefixPaddingMs ?? 20, "Gemini VAD prefixPaddingMs", 0, 2_000);
  const silenceDurationMs = safeInteger(options.silenceDurationMs ?? 100, "Gemini VAD silenceDurationMs", 50, 5_000);

  return Object.freeze({
    setup: Object.freeze({
      model: modelResourceName(options.model),
      generationConfig: Object.freeze({
        responseModalities: Object.freeze(["AUDIO"]),
        thinkingConfig: Object.freeze({ thinkingLevel: "MINIMAL" }),
        speechConfig: Object.freeze({
          voiceConfig: Object.freeze({
            prebuiltVoiceConfig: Object.freeze({ voiceName }),
          }),
          languageCode,
        }),
      }),
      systemInstruction: Object.freeze({ parts: Object.freeze([{ text: instruction }]) }),
      tools: tools.length ? Object.freeze([{ functionDeclarations: Object.freeze(tools) }]) : Object.freeze([]),
      realtimeInputConfig: Object.freeze({
        automaticActivityDetection: Object.freeze({
          disabled: false,
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
          endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
          prefixPaddingMs,
          silenceDurationMs,
        }),
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
        turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
      }),
      sessionResumption: Object.freeze({}),
      inputAudioTranscription: Object.freeze({}),
      outputAudioTranscription: Object.freeze({}),
    }),
  });
}

export function buildFastRealtimeAudio(base64Payload, sampleRateHz = DEFAULT_INPUT_RATE_HZ) {
  const payload = requiredString(base64Payload, "Gemini realtime audio payload", 2_000_000);
  safeInteger(sampleRateHz, "Gemini realtime audio sample rate", 8_000, 96_000);
  return Object.freeze({
    realtimeInput: Object.freeze({
      audio: Object.freeze({
        data: payload,
        mimeType: `audio/pcm;rate=${sampleRateHz}`,
      }),
    }),
  });
}

export function buildFastFunctionResponse(call, output) {
  if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error("Gemini function call is invalid");
  const id = requiredString(call.id, "Gemini function call id", 256);
  const name = requiredString(call.name, "Gemini function call name", 128);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Gemini function call name is invalid");
  if (output === undefined) throw new Error("Gemini function response output is required");
  return Object.freeze({
    toolResponse: Object.freeze({
      functionResponses: Object.freeze([Object.freeze({
        id,
        name,
        response: Object.freeze({ result: structuredClone(output) }),
      })]),
    }),
  });
}

function normalizedServer(message) {
  return message?.serverContent ?? message?.server_content ?? null;
}

function normalizedParts(server) {
  const parts = server?.modelTurn?.parts ?? server?.model_turn?.parts;
  return Array.isArray(parts) ? parts : [];
}

function normalizedToolCalls(message) {
  const calls = message?.toolCall?.functionCalls ?? message?.tool_call?.function_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => Object.freeze({
    id: requiredString(call?.id, "Gemini function call id", 256),
    name: requiredString(call?.name, "Gemini function call name", 128),
    args: call?.args && typeof call.args === "object" && !Array.isArray(call.args) ? structuredClone(call.args) : Object.freeze({}),
  }));
}

/**
 * Parses one Gemini 3.1 Live server frame without assuming one-part-per-frame.
 * All audio parts are returned in-order, together with tool calls and lifecycle
 * evidence that may coexist in the same WebSocket message.
 */
export function parseFastGemini31ServerFrame(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Gemini server frame is invalid");
  const server = normalizedServer(message);
  const audio = [];
  const texts = [];
  for (const part of normalizedParts(server)) {
    const inline = part?.inlineData ?? part?.inline_data;
    const mime = inline?.mimeType ?? inline?.mime_type;
    if (typeof inline?.data === "string" && typeof mime === "string" && /^audio\/pcm(?:;|$)/i.test(mime)) {
      audio.push(Object.freeze({ data: inline.data, mimeType: mime }));
    }
    if (typeof part?.text === "string" && part.text) texts.push(part.text);
  }

  const inputTranscript = message?.inputTranscription?.text
    ?? message?.input_transcription?.text
    ?? server?.inputTranscription?.text
    ?? server?.input_transcription?.text
    ?? null;
  const outputTranscript = message?.outputTranscription?.text
    ?? message?.output_transcription?.text
    ?? server?.outputTranscription?.text
    ?? server?.output_transcription?.text
    ?? null;
  const resumption = message?.sessionResumptionUpdate ?? message?.session_resumption_update ?? null;
  const goAway = message?.goAway ?? message?.go_away ?? null;
  const setupComplete = message?.setupComplete !== undefined || message?.setup_complete !== undefined;

  return Object.freeze({
    setupComplete,
    audio: Object.freeze(audio),
    texts: Object.freeze(texts),
    toolCalls: Object.freeze(normalizedToolCalls(message)),
    interrupted: server?.interrupted === true,
    turnComplete: server?.turnComplete === true || server?.turn_complete === true,
    inputTranscript: typeof inputTranscript === "string" ? inputTranscript : null,
    outputTranscript: typeof outputTranscript === "string" ? outputTranscript : null,
    sessionResumptionToken: typeof resumption?.token === "string" && resumption.token ? resumption.token : null,
    goAwayTimeLeftMs: Number.isSafeInteger(goAway?.timeLeftMs)
      ? goAway.timeLeftMs
      : Number.isSafeInteger(goAway?.time_left_ms) ? goAway.time_left_ms : null,
  });
}

export const FAST_GEMINI31_DEFAULTS = Object.freeze({
  model: DEFAULT_MODEL,
  voiceName: DEFAULT_VOICE,
  languageCode: DEFAULT_LANGUAGE,
  inputSampleRateHz: DEFAULT_INPUT_RATE_HZ,
  prefixPaddingMs: 20,
  silenceDurationMs: 100,
});
