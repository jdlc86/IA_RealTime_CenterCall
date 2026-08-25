import { WebSocket } from "ws";
import { buildGeminiInitialSetup, isGeminiSetupComplete } from "./bootstrap.mjs";

const GEMINI_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const EXPECTED_TOOL = "restaurant_reservation_create";
const FIXED_INPUT = "Quiero hacer una reserva.";
const OPEN = 1;

const PROBE_BOOTSTRAP = Object.freeze({
  credentialId: "live-provider-contract-probe",
  tenantId: "provider-contract-probe",
  callControlId: "provider-contract-probe",
  notAfterEpochMs: 1,
  instructions: [
    "Eres una agente telefónica de restaurante en una prueba técnica sin datos reales.",
    "Antes de responder a cualquier turno significativo selecciona exactamente la herramienta pública que representa su función.",
    "Para cualquier intención de iniciar o continuar una reserva usa restaurant_reservation_create desde el primer turno, aunque todavía falten fecha, hora, personas, nombre, contacto o confirmación; el backend indicará qué falta.",
    "Usa restaurant_conversation únicamente para diálogo ordinario que no pertenezca a una operación activa.",
    "No respondas directamente a una intención de reserva antes de emitir el function call de restaurant_reservation_create.",
  ].join("\n"),
  tools: Object.freeze([
    Object.freeze({
      type: "function",
      name: EXPECTED_TOOL,
      description: "Crea o continúa una reserva multivuelta cuando el cliente ha elegido una fecha y hora concretas. Úsala también para recopilar progresivamente los demás datos; el backend indicará qué falta.",
      parameters: Object.freeze({
        type: "object",
        properties: Object.freeze({
          party_size: Object.freeze({ type: "integer", minimum: 1, maximum: 100 }),
          starts_at: Object.freeze({ type: "string" }),
          customer_name: Object.freeze({ type: "string" }),
          confirm: Object.freeze({ type: "boolean" }),
        }),
        additionalProperties: false,
      }),
    }),
    Object.freeze({
      type: "function",
      name: "restaurant_conversation",
      description: "Resuelve conversación natural que no pertenece a una operación, consulta de datos, acción, escalado ni cierre.",
      parameters: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
    }),
    Object.freeze({
      type: "function",
      name: "restaurant_business_info",
      description: "Obtiene información oficial del restaurante.",
      parameters: Object.freeze({
        type: "object",
        properties: Object.freeze({ topics: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }) }),
        required: Object.freeze(["topics"]),
        additionalProperties: false,
      }),
    }),
  ]),
  manualActivityDetection: true,
  manualActivityHandling: "START_OF_ACTIVITY_INTERRUPTS",
});

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function failure(failureCategory, details = {}) {
  return Object.freeze({ status: "failed", failureCategory, ...details });
}

function boundedProviderCode(value) {
  if (value === undefined || value === null) return undefined;
  const code = String(value).trim();
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : undefined;
}

function providerToolCalls(message) {
  const calls = message?.toolCall?.functionCalls ?? message?.tool_call?.function_calls;
  return Array.isArray(calls) ? calls : [];
}

function partHasDirectOutput(part) {
  if (!part || typeof part !== "object" || Array.isArray(part)) return true;
  if (part.thought === true) return false;
  if (typeof part.text === "string" && part.text.trim()) return true;
  const inline = part.inlineData ?? part.inline_data;
  if (inline !== undefined) {
    if (!inline || typeof inline !== "object" || Array.isArray(inline)) return true;
    if (typeof inline.data === "string" && inline.data.length > 0) return true;
    if (Object.keys(inline).length > 0) return true;
  }
  const metadata = new Set(["thought", "thoughtSignature", "thought_signature", "partMetadata", "part_metadata"]);
  return Object.keys(part).some((key) => !metadata.has(key));
}

function providerProducedDirectOutput(message) {
  const server = message?.serverContent ?? message?.server_content;
  if (!server || typeof server !== "object" || Array.isArray(server)) return false;
  const output = server.outputTranscription ?? server.output_transcription;
  if (typeof output?.text === "string" && output.text.trim()) return true;
  const modelTurn = server.modelTurn ?? server.model_turn;
  if (modelTurn === undefined || modelTurn === null) return false;
  if (typeof modelTurn !== "object" || Array.isArray(modelTurn)) return true;
  if (modelTurn.parts === undefined) return false;
  if (!Array.isArray(modelTurn.parts)) return true;
  return modelTurn.parts.some(partHasDirectOutput);
}

function providerTurnComplete(message) {
  const server = message?.serverContent ?? message?.server_content;
  return Boolean(server && typeof server === "object" && !Array.isArray(server)
    && (server.turnComplete === true || server.turn_complete === true));
}

export async function runGeminiLiveProviderContractProbe(options = {}) {
  let apiKey;
  let model;
  try {
    apiKey = required(options.apiKey, "Gemini Live provider probe API key");
    model = required(options.model ?? "gemini-3.1-flash-live-preview", "Gemini Live provider probe model");
  } catch {
    return failure("CONFIGURATION");
  }
  const timeoutMs = Number(options.timeoutMs ?? 12_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) return failure("CONFIGURATION");
  const createSocket = options.createSocket ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
  if (typeof createSocket !== "function") return failure("CONFIGURATION");

  return new Promise((resolve) => {
    let socket;
    let settled = false;
    let setupComplete = false;
    let inputSent = false;
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
    const timer = setTimeout(() => settle(failure("TIMEOUT")), timeoutMs);

    try {
      const url = new URL(GEMINI_ENDPOINT);
      url.searchParams.set("key", apiKey);
      socket = createSocket(url, { perMessageDeflate: false });
      if (!socket || typeof socket.on !== "function" || typeof socket.send !== "function") {
        settle(failure("SOCKET_FACTORY"));
        return;
      }
      socket.on("open", () => {
        try {
          socket.send(JSON.stringify(buildGeminiInitialSetup(PROBE_BOOTSTRAP, model)));
        } catch {
          settle(failure("SETUP_SEND"));
        }
      });
      socket.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
        } catch {
          settle(failure("MALFORMED_PROVIDER_MESSAGE"));
          return;
        }

        const providerErrorCode = boundedProviderCode(message?.error?.code);
        if (message?.error) {
          settle(failure("PROVIDER_ERROR", providerErrorCode ? { providerErrorCode } : {}));
          return;
        }

        if (isGeminiSetupComplete(message)) {
          if (setupComplete || inputSent) {
            settle(failure("SETUP_ORDER"));
            return;
          }
          setupComplete = true;
          inputSent = true;
          try {
            socket.send(JSON.stringify({ realtimeInput: { text: FIXED_INPUT } }));
          } catch {
            settle(failure("INPUT_SEND"));
          }
          return;
        }

        if (!setupComplete) {
          settle(failure("PRE_SETUP_MESSAGE"));
          return;
        }

        const calls = providerToolCalls(message);
        if (calls.length > 0) {
          if (calls.length !== 1) {
            settle(failure("MULTIPLE_TOOL_CALLS"));
            return;
          }
          const call = calls[0];
          const callId = typeof call?.id === "string" ? call.id.trim() : "";
          const name = typeof call?.name === "string" ? call.name.trim() : "";
          if (!callId) {
            settle(failure("MISSING_PROVIDER_CALL_ID"));
            return;
          }
          if (name !== EXPECTED_TOOL) {
            settle(failure("TOOL_MISMATCH", name && /^[A-Za-z0-9_-]{1,128}$/.test(name) ? { observedTool: name } : {}));
            return;
          }
          settle(Object.freeze({ status: "ready", expectedTool: EXPECTED_TOOL }));
          return;
        }

        if (providerProducedDirectOutput(message)) {
          settle(failure("DIRECT_OUTPUT_BEFORE_TOOL_CALL"));
          return;
        }
        if (providerTurnComplete(message)) settle(failure("TURN_COMPLETE_WITHOUT_TOOL_CALL"));
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

export const GEMINI_LIVE_PROVIDER_PROBE_EXPECTED_TOOL = EXPECTED_TOOL;
