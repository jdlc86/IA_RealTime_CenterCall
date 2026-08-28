import assert from "node:assert/strict";
import test from "node:test";
import {
  FAST_GEMINI31_DEFAULTS,
  buildFastFunctionResponse,
  buildFastGemini31Setup,
  buildFastRealtimeAudio,
  parseFastGemini31ServerFrame,
} from "./fast-gemini31.mjs";
import { FAST_HORIZONTAL_TOOL_POLICIES, defineFastToolPolicy } from "./fast-tool-authorization-kernel.mjs";

const reservationPolicy = defineFastToolPolicy({
  authority: "CALLER_REQUEST",
  effect: "MUTATE_BUSINESS_DATA",
  capability: "reservation.create",
});

test("fast Gemini 3.1 setup is audio-native, minimal-thinking and automatic-VAD", () => {
  const setup = buildFastGemini31Setup({
    systemInstruction: "Atiende el restaurante con respuestas breves y naturales.",
    tools: [{
      name: "restaurant_reservation_create",
      description: "Create or continue a reservation.",
      parameters: {
        type: "object",
        properties: { party_size: { type: "integer" } },
      },
    }],
    toolPolicies: { restaurant_reservation_create: reservationPolicy },
  });

  assert.equal(setup.setup.model, "models/gemini-3.1-flash-live-preview");
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(setup.setup.generationConfig.thinkingConfig.thinkingLevel, "MINIMAL");
  assert.equal(setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
  assert.equal(setup.setup.generationConfig.speechConfig.languageCode, "es-ES");
  assert.equal(setup.setup.realtimeInputConfig.automaticActivityDetection.disabled, false);
  assert.equal(setup.setup.realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity, "START_SENSITIVITY_HIGH");
  assert.equal(setup.setup.realtimeInputConfig.automaticActivityDetection.endOfSpeechSensitivity, "END_SENSITIVITY_HIGH");
  assert.equal(setup.setup.realtimeInputConfig.automaticActivityDetection.prefixPaddingMs, 20);
  assert.equal(setup.setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 100);
  assert.equal(setup.setup.realtimeInputConfig.activityHandling, "START_OF_ACTIVITY_INTERRUPTS");
  assert.equal(setup.setup.realtimeInputConfig.turnCoverage, "TURN_INCLUDES_ONLY_ACTIVITY");
  assert.deepEqual(setup.setup.sessionResumption, {});
  const declaration = setup.setup.tools[0].functionDeclarations[0];
  assert.equal(declaration.behavior, "BLOCKING");
  assert.deepEqual(declaration.parametersJsonSchema.properties.authorization.enum, ["CALLER_REQUEST"]);
  assert.ok(declaration.parametersJsonSchema.required.includes("caller_authority_evidence"));
});

test("read-only temporal setup requires semantic authority without transcript evidence", () => {
  const setup = buildFastGemini31Setup({
    systemInstruction: "Usa el reloj solo cuando el significado completo del turno lo requiera.",
    tools: [{
      name: "get_authoritative_datetime",
      description: "Current clock/calendar authority only.",
      parameters: { type: "object", properties: {} },
    }],
    toolPolicies: FAST_HORIZONTAL_TOOL_POLICIES,
  });
  const declaration = setup.setup.tools[0].functionDeclarations[0];
  assert.deepEqual(declaration.parametersJsonSchema.properties.authorization.enum, ["SEMANTIC_NECESSITY"]);
  assert.equal("caller_authority_evidence" in declaration.parametersJsonSchema.properties, false);
  assert.deepEqual(declaration.parametersJsonSchema.required, ["authorization"]);
});

test("fast Gemini setup fails closed when a declared tool has no local policy", () => {
  assert.throws(() => buildFastGemini31Setup({
    systemInstruction: "Test.",
    tools: [{
      name: "unregistered_business_tool",
      description: "Do something.",
      parameters: { type: "object", properties: {} },
    }],
  }), /tool policy required/);
});

test("caller PCM base64 can be forwarded to Gemini without decode/re-encode", () => {
  const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]).toString("base64");
  const message = buildFastRealtimeAudio(payload);
  assert.equal(message.realtimeInput.audio.data, payload);
  assert.equal(message.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
});

test("Gemini 3.1 parser consumes every audio part in one server frame", () => {
  const frame = parseFastGemini31ServerFrame({
    serverContent: {
      modelTurn: {
        parts: [
          { inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } },
          { text: "auxiliary text" },
          { inlineData: { mimeType: "audio/pcm;rate=24000", data: "BBB=" } },
        ],
      },
      interrupted: true,
      turnComplete: true,
      inputTranscription: { text: "hola" },
      outputTranscription: { text: "buenas" },
    },
    sessionResumptionUpdate: { token: "resume-1" },
    goAway: { timeLeftMs: 1234 },
    toolCall: {
      functionCalls: [{
        id: "tool-1",
        name: "restaurant_reservation_create",
        args: { party_size: 2 },
      }],
    },
  });

  assert.deepEqual(frame.audio, [
    { mimeType: "audio/pcm;rate=24000", data: "AAA=" },
    { mimeType: "audio/pcm;rate=24000", data: "BBB=" },
  ]);
  assert.deepEqual(frame.texts, ["auxiliary text"]);
  assert.deepEqual(frame.toolCalls, [{
    id: "tool-1",
    name: "restaurant_reservation_create",
    args: { party_size: 2 },
  }]);
  assert.equal(frame.interrupted, true);
  assert.equal(frame.turnComplete, true);
  assert.equal(frame.inputTranscript, "hola");
  assert.equal(frame.outputTranscript, "buenas");
  assert.equal(frame.sessionResumptionToken, "resume-1");
  assert.equal(frame.goAwayTimeLeftMs, 1234);
});

test("function response preserves exact Gemini tool call identity", () => {
  const response = buildFastFunctionResponse({
    id: "call-123",
    name: "restaurant_reservation_create",
  }, { status: "NEEDS_CONFIRMATION" });
  assert.deepEqual(response, {
    toolResponse: {
      functionResponses: [{
        id: "call-123",
        name: "restaurant_reservation_create",
        response: { result: { status: "NEEDS_CONFIRMATION" } },
      }],
    },
  });
});

test("fast defaults remain explicitly latency-oriented", () => {
  assert.deepEqual(FAST_GEMINI31_DEFAULTS, {
    model: "gemini-3.1-flash-live-preview",
    voiceName: "Kore",
    languageCode: "es-ES",
    inputSampleRateHz: 16000,
    prefixPaddingMs: 20,
    silenceDurationMs: 100,
  });
});
