import { WebSocket } from "ws";

const GEMINI_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const OPEN = 1;
const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_VOICE = "Kore";
const CONTROL_TURNS = Object.freeze([
  "CONTROL_GREETING: Di brevemente: Hola, prueba de saludo.",
  "CONTROL_TERMINAL: Di brevemente: Hasta luego, prueba terminada.",
]);

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function modelResourceName(value) {
  const model = required(value, "Gemini control speech probe model");
  const identifier = model.startsWith("models/") ? model.slice("models/".length) : model;
  if (!/^[A-Za-z0-9._-]+$/.test(identifier)) throw new Error("Gemini control speech probe model is invalid");
  return `models/${identifier}`;
}

function failure(failureCategory, details = {}) {
  return Object.freeze({ status: "failed", failureCategory, ...details });
}

function isSetupComplete(message) {
  return Boolean(message && typeof message === "object" && !Array.isArray(message)
    && (message.setupComplete !== undefined || message.setup_complete !== undefined));
}

function serverContent(message) {
  const value = message?.serverContent ?? message?.server_content;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function providerToolCalls(message) {
  const calls = message?.toolCall?.functionCalls ?? message?.tool_call?.function_calls;
  return Array.isArray(calls) ? calls : [];
}

function audioBytesFrom(message) {
  const server = serverContent(message);
  const modelTurn = server?.modelTurn ?? server?.model_turn;
  const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
  let bytes = 0;
  for (const part of parts) {
    const inline = part?.inlineData ?? part?.inline_data;
    const data = typeof inline?.data === "string" ? inline.data : "";
    if (!data) continue;
    try { bytes += Buffer.from(data, "base64").length; } catch {}
  }
  return bytes;
}

function turnComplete(message) {
  const server = serverContent(message);
  return Boolean(server && (server.turnComplete === true || server.turn_complete === true));
}

function boundedProviderCode(value) {
  if (value === undefined || value === null) return undefined;
  const code = String(value).trim();
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : undefined;
}

function buildSetup(model, voiceName) {
  return Object.freeze({
    setup: {
      model: modelResourceName(model),
      systemInstruction: {
        parts: [{
          text: [
            "Eres una voz de prueba técnica sin datos reales.",
            "Los mensajes que empiezan por CONTROL_ son instrucciones internas de sistema para producir una frase breve.",
            "No llames herramientas y no añadas contenido distinto del solicitado.",
          ].join("\n"),
        }],
      },
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
      },
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
    },
  });
}

export async function runGeminiLiveControlSpeechProbe(options = {}) {
  let apiKey;
  let model;
  let voiceName;
  try {
    apiKey = required(options.apiKey, "Gemini control speech probe API key");
    model = required(options.model ?? DEFAULT_MODEL, "Gemini control speech probe model");
    voiceName = required(options.voiceName ?? DEFAULT_VOICE, "Gemini control speech probe voice");
  } catch {
    return failure("CONFIGURATION");
  }

  const timeoutMs = Number(options.timeoutMs ?? 20_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 45_000) return failure("CONFIGURATION");
  const createSocket = options.createSocket ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
  if (typeof createSocket !== "function") return failure("CONFIGURATION");

  return new Promise((resolve) => {
    let socket;
    let settled = false;
    let setupComplete = false;
    let activeTurn = -1;
    const audioBytes = CONTROL_TURNS.map(() => 0);

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (typeof socket?.terminate === "function") socket.terminate();
        else if (typeof socket?.close === "function") socket.close();
      } catch {}
      resolve(Object.freeze(result));
    };

    const sendTurn = (index) => {
      activeTurn = index;
      try {
        socket.send(JSON.stringify({ realtimeInput: { text: CONTROL_TURNS[index] } }));
      } catch {
        settle(failure("CONTROL_TEXT_SEND", { controlTurn: index + 1 }));
      }
    };

    const timer = setTimeout(() => settle(failure("TIMEOUT", { controlTurn: activeTurn + 1 })), timeoutMs);

    try {
      const url = new URL(GEMINI_ENDPOINT);
      url.searchParams.set("key", apiKey);
      socket = createSocket(url, { perMessageDeflate: false });
      if (!socket || typeof socket.on !== "function" || typeof socket.send !== "function") {
        settle(failure("SOCKET_FACTORY"));
        return;
      }

      socket.on("open", () => {
        try { socket.send(JSON.stringify(buildSetup(model, voiceName))); }
        catch { settle(failure("SETUP_SEND")); }
      });

      socket.on("message", (raw) => {
        let message;
        try { message = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")); }
        catch { settle(failure("MALFORMED_PROVIDER_MESSAGE")); return; }

        const providerErrorCode = boundedProviderCode(message?.error?.code);
        if (message?.error) {
          settle(failure("PROVIDER_ERROR", providerErrorCode ? { providerErrorCode } : {}));
          return;
        }

        if (isSetupComplete(message)) {
          if (setupComplete || activeTurn !== -1) {
            settle(failure("SETUP_ORDER"));
            return;
          }
          setupComplete = true;
          sendTurn(0);
          return;
        }

        if (!setupComplete) {
          settle(failure("PRE_SETUP_MESSAGE"));
          return;
        }

        if (providerToolCalls(message).length > 0) {
          settle(failure("UNEXPECTED_TOOL_CALL", { controlTurn: activeTurn + 1 }));
          return;
        }

        if (activeTurn >= 0) audioBytes[activeTurn] += audioBytesFrom(message);

        if (!turnComplete(message)) return;
        if (activeTurn < 0 || activeTurn >= CONTROL_TURNS.length) {
          settle(failure("UNEXPECTED_TURN_COMPLETE"));
          return;
        }
        if (audioBytes[activeTurn] <= 0) {
          settle(failure("TURN_COMPLETE_WITHOUT_AUDIO", { controlTurn: activeTurn + 1 }));
          return;
        }

        if (activeTurn + 1 < CONTROL_TURNS.length) {
          sendTurn(activeTurn + 1);
          return;
        }

        settle({
          status: "ready",
          nativeAudio: true,
          sameLiveSession: true,
          configuredVoice: voiceName,
          controlTurns: CONTROL_TURNS.length,
          audioBytes: Object.freeze([...audioBytes]),
        });
      });

      socket.on("error", () => settle(failure("TRANSPORT")));
      socket.on("close", (code) => {
        const closeCode = Number(code);
        settle(failure("SOCKET_CLOSED", Number.isSafeInteger(closeCode) ? { closeCode } : {}));
      });
    } catch {
      settle(failure("TRANSPORT"));
    }
  });
}

export const GEMINI_CONTROL_SPEECH_PROBE_VOICE = DEFAULT_VOICE;
export const GEMINI_CONTROL_SPEECH_PROBE_TURN_COUNT = CONTROL_TURNS.length;
