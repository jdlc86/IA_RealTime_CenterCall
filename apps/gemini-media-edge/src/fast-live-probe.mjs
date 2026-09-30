import { WebSocket } from "ws";
import { buildFastGemini31Setup, parseFastGemini31ServerFrame } from "./fast-gemini31.mjs";

const GEMINI_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

function required(value, field, max = 8_192) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /\u0000/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function parseJson(raw) {
  try { return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")); }
  catch { throw new Error("Gemini fast probe received invalid JSON"); }
}

function safeClose(socket) {
  try { socket?.close(1000, "probe complete"); } catch {}
}

function category(error) {
  const text = error instanceof Error ? error.message : "";
  if (/timeout/i.test(text)) return "TIMEOUT";
  if (/setup/i.test(text)) return "SETUP_FAILED";
  if (/audio/i.test(text)) return "AUDIO_MISSING";
  if (/socket/i.test(text)) return "SOCKET_FAILED";
  return "PROVIDER_CONTRACT_FAILED";
}

export async function runFastGeminiLiveProbe(options = {}) {
  const apiKey = required(options.apiKey, "GEMINI_API_KEY");
  const model = options.model ?? "gemini-3.1-flash-live-preview";
  const createSocket = options.createSocket ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : 12_000;
  if (timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("Gemini fast probe timeout is invalid");

  const url = new URL(GEMINI_ENDPOINT);
  url.searchParams.set("key", apiKey);
  const socket = createSocket(url, { perMessageDeflate: false });
  const startedAt = performance.now();
  let setupAt = null;
  let firstAudioAt = null;
  let audioParts = 0;
  let turnComplete = false;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      safeClose(socket);
      resolve(Object.freeze(result));
    };
    const fail = (error) => finish({
      status: "failed",
      failureCategory: category(error),
      setupMs: setupAt === null ? null : Math.round(setupAt - startedAt),
      firstAudioMs: firstAudioAt === null || setupAt === null ? null : Math.round(firstAudioAt - setupAt),
      audioParts,
      turnComplete,
    });
    const timer = setTimeout(() => fail(new Error("Gemini fast probe timeout")), timeoutMs);

    socket.on("open", () => {
      try {
        socket.send(JSON.stringify(buildFastGemini31Setup({
          model,
          systemInstruction: "This is a readiness probe. Reply briefly in Spanish with native audio.",
          tools: [],
          voiceName: options.voiceName ?? "Kore",
          languageCode: "es-ES",
        })));
      } catch (error) { fail(error); }
    });

    socket.on("message", (raw) => {
      try {
        const frame = parseFastGemini31ServerFrame(parseJson(raw));
        if (frame.setupComplete && setupAt === null) {
          setupAt = performance.now();
          socket.send(JSON.stringify({ realtimeInput: { text: "Di un saludo muy breve en español." } }));
        }
        if (frame.audio.length) {
          if (setupAt === null) throw new Error("Gemini fast probe received audio before setup");
          if (firstAudioAt === null) firstAudioAt = performance.now();
          audioParts += frame.audio.length;
        }
        if (frame.turnComplete) turnComplete = true;
        if (firstAudioAt !== null && turnComplete) {
          finish({
            status: "ready",
            model,
            setupMs: Math.round(setupAt - startedAt),
            firstAudioMs: Math.round(firstAudioAt - setupAt),
            audioParts,
            turnComplete: true,
          });
        }
      } catch (error) { fail(error); }
    });
    socket.on("error", () => fail(new Error("Gemini fast probe socket error")));
    socket.on("close", () => {
      if (!settled) fail(new Error("Gemini fast probe socket closed"));
    });
  });
}
