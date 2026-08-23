import { WebSocket, WebSocketServer } from "ws";
import { requireTelnyxStartForCredential } from "./credential.mjs";

const GEMINI_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const CONNECTING = 0;
const OPEN = 1;

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function parseJson(data, source) {
  try { return JSON.parse(typeof data === "string" ? data : data.toString("utf8")); }
  catch { throw new Error(`Invalid ${source} JSON`); }
}

function decodeBase64(value) { return Buffer.from(required(value, "audio payload"), "base64"); }
function encodeBase64(value) { return Buffer.from(value).toString("base64"); }

function bearerCredential(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") throw new Error("missing authorization");
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match?.[1]?.trim()) throw new Error("missing bearer credential");
  return match[1].trim();
}

export function swapPcm16Endianness(bytes) {
  if (bytes.length % 2 !== 0) throw new Error("PCM16 payload must contain complete 16-bit samples");
  const output = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < bytes.length; i += 2) { output[i] = bytes[i + 1]; output[i + 1] = bytes[i]; }
  return output;
}

export class Pcm16Resampler24To16 {
  constructor() { this.pending = null; this.phase = 0; }
  reset() { this.pending = null; this.phase = 0; }
  push(bytes) {
    if (bytes.length % 2 !== 0) throw new Error("Gemini PCM16 output must contain complete samples");
    const source = [];
    if (this.pending !== null) source.push(this.pending);
    for (let i = 0; i < bytes.length; i += 2) source.push(bytes.readInt16LE(i));
    if (source.length < 2) { this.pending = source[0] ?? null; return Buffer.alloc(0); }
    const out = [];
    let position = this.phase;
    while (position + 1 < source.length) {
      const left = Math.floor(position);
      const fraction = position - left;
      const sample = Math.round(source[left] + (source[left + 1] - source[left]) * fraction);
      out.push(Math.max(-32768, Math.min(32767, sample)));
      position += 1.5;
    }
    const consumed = Math.floor(position);
    this.phase = position - consumed;
    this.pending = source[source.length - 1];
    const result = Buffer.allocUnsafe(out.length * 2);
    out.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
    return result;
  }
}

function geminiAudioPayloads(message) {
  const parts = message?.serverContent?.modelTurn?.parts ?? message?.server_content?.model_turn?.parts ?? [];
  const result = [];
  for (const part of parts) {
    const inline = part?.inlineData ?? part?.inline_data;
    const data = inline?.data;
    const mime = inline?.mimeType ?? inline?.mime_type;
    if (typeof data === "string" && typeof mime === "string" && /^audio\/pcm(?:;|$)/i.test(mime)) result.push(data);
  }
  return result;
}

function safeSend(socket, message) {
  if (socket.readyState !== OPEN) throw new Error("Media edge socket is not open");
  socket.send(typeof message === "string" || Buffer.isBuffer(message) ? message : JSON.stringify(message));
}

export function createGeminiMediaEdgeRuntime(options) {
  const apiKey = required(options.geminiApiKey, "GEMINI_API_KEY");
  if (typeof options.verifyCredential !== "function") throw new Error("Gemini media edge credential verifier is required");
  if (typeof options.consumeCredentialOnce !== "function") throw new Error("Gemini media edge credential consumer is required");
  const maxBufferedBytes = Number(options.maxBufferedBytes ?? 1_048_576);
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 65_536) throw new Error("MEDIA_EDGE_MAX_BUFFERED_BYTES is invalid");

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });
  const sessions = new Set();
  const pendingAuthorizations = new WeakMap();

  function rejectUpgrade(socket, status = "401 Unauthorized") {
    try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch {}
    socket.destroy();
  }

  async function handleUpgrade(request, socket, head) {
    let claims;
    try {
      const credential = bearerCredential(request);
      claims = await options.verifyCredential(credential, Date.now());
    } catch {
      return rejectUpgrade(socket);
    }
    if (!claims || claims.provider !== "GEMINI") return rejectUpgrade(socket);
    wss.handleUpgrade(request, socket, head, (client) => {
      pendingAuthorizations.set(client, claims);
      wss.emit("connection", client, request);
    });
  }

  wss.on("connection", (telnyx) => {
    const claims = pendingAuthorizations.get(telnyx);
    pendingAuthorizations.delete(telnyx);
    if (!claims) { try { telnyx.close(); } catch {} return; }

    const state = {
      telnyx,
      gemini: null,
      claims,
      authorized: false,
      started: false,
      streamId: null,
      nextChunk: 1,
      buffered: new Map(),
      pendingInbound: [],
      pendingInboundBytes: 0,
      resampler: new Pcm16Resampler24To16(),
      closed: false,
      telnyxChain: Promise.resolve(),
    };
    sessions.add(state);

    const closeBoth = () => {
      if (state.closed) return;
      state.closed = true;
      state.buffered.clear();
      state.pendingInbound.length = 0;
      state.pendingInboundBytes = 0;
      sessions.delete(state);
      try { if (telnyx.readyState === OPEN || telnyx.readyState === CONNECTING) telnyx.close(); } catch {}
      try { if (state.gemini?.readyState === OPEN || state.gemini?.readyState === CONNECTING) state.gemini.close(); } catch {}
    };

    const assertBackpressure = (socket, label) => {
      if (socket.bufferedAmount > maxBufferedBytes) throw new Error(`${label} backpressure limit exceeded`);
    };

    const sendInboundToGemini = (payload) => {
      const pcm16le = swapPcm16Endianness(decodeBase64(payload));
      if (state.gemini?.readyState === OPEN) {
        assertBackpressure(state.gemini, "Gemini Live");
        safeSend(state.gemini, { realtimeInput: { audio: { data: encodeBase64(pcm16le), mimeType: "audio/pcm;rate=16000" } } });
        return;
      }
      state.pendingInbound.push(pcm16le);
      state.pendingInboundBytes += pcm16le.length;
      if (state.pendingInboundBytes > maxBufferedBytes) throw new Error("Gemini Live startup buffer limit exceeded");
    };

    const openGemini = () => {
      if (state.gemini) throw new Error("Gemini Live connection is one-shot");
      const geminiUrl = new URL(GEMINI_ENDPOINT);
      geminiUrl.searchParams.set("key", apiKey);
      const gemini = new WebSocket(geminiUrl, { perMessageDeflate: false });
      state.gemini = gemini;

      gemini.on("open", () => {
        try {
          safeSend(gemini, {
            setup: {
              model: options.model ?? "gemini-3.1-flash-live-preview",
              generationConfig: { responseModalities: ["AUDIO"] },
            },
          });
          for (const pcm16le of state.pendingInbound) {
            assertBackpressure(gemini, "Gemini Live");
            safeSend(gemini, { realtimeInput: { audio: { data: encodeBase64(pcm16le), mimeType: "audio/pcm;rate=16000" } } });
          }
          state.pendingInbound.length = 0;
          state.pendingInboundBytes = 0;
        } catch { closeBoth(); }
      });

      gemini.on("message", (raw) => {
        try {
          const message = parseJson(raw, "Gemini Live");
          for (const payload of geminiAudioPayloads(message)) {
            const pcm16le16k = state.resampler.push(decodeBase64(payload));
            if (pcm16le16k.length === 0) continue;
            const l16 = swapPcm16Endianness(pcm16le16k);
            assertBackpressure(telnyx, "Telnyx");
            safeSend(telnyx, { event: "media", media: { payload: encodeBase64(l16) } });
          }
        } catch { closeBoth(); }
      });
      gemini.on("error", closeBoth);
      gemini.on("close", closeBoth);
    };

    async function observeTelnyx(raw) {
      const message = parseJson(raw, "Telnyx media");
      const event = message?.event;
      if (event === "connected") return;

      if (event === "start") {
        if (state.started) throw new Error("Telnyx media start is one-shot");
        const verifiedStart = requireTelnyxStartForCredential(state.claims, message);
        const consumed = await options.consumeCredentialOnce(
          state.claims.credentialId,
          state.claims.notAfterEpochMs,
          Date.now(),
        );
        if (consumed !== true) throw new Error("Gemini media edge credential already consumed");
        state.streamId = verifiedStart.streamId;
        state.authorized = true;
        state.started = true;
        openGemini();
        return;
      }

      if (!state.authorized || !state.started) throw new Error("Telnyx media received before authorized start");
      if (typeof message.stream_id === "string" && message.stream_id.trim() !== state.streamId) {
        throw new Error("Telnyx media stream identity changed");
      }
      if (event === "stop") return closeBoth();
      if (event !== "media" || message?.media?.track !== "inbound") return;

      const chunk = Number(message.media.chunk);
      if (!Number.isSafeInteger(chunk) || chunk < 1) throw new Error("Invalid Telnyx media chunk");
      const payload = required(message.media.payload, "Telnyx media payload");
      if (chunk < state.nextChunk) return;
      if (!state.buffered.has(chunk)) state.buffered.set(chunk, payload);
      if (state.buffered.size > 64) throw new Error("Telnyx media reorder window exceeded");
      while (state.buffered.has(state.nextChunk)) {
        const ordered = state.buffered.get(state.nextChunk);
        state.buffered.delete(state.nextChunk);
        state.nextChunk += 1;
        sendInboundToGemini(ordered);
      }
    }

    telnyx.on("message", (raw) => {
      state.telnyxChain = state.telnyxChain.then(() => observeTelnyx(raw)).catch(() => closeBoth());
    });
    telnyx.on("error", closeBoth);
    telnyx.on("close", closeBoth);
  });

  return Object.freeze({
    wss,
    handleUpgrade,
    activeSessions: () => sessions.size,
    async close() {
      for (const session of [...sessions]) {
        try { session.telnyx.close(); session.gemini?.close(); } catch {}
      }
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  });
}
