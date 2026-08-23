import { WebSocket, WebSocketServer } from "ws";

const GEMINI_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
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
  const ingressToken = required(options.ingressToken, "MEDIA_EDGE_INGRESS_TOKEN");
  const maxBufferedBytes = Number(options.maxBufferedBytes ?? 1_048_576);
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 65_536) throw new Error("MEDIA_EDGE_MAX_BUFFERED_BYTES is invalid");

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });
  const sessions = new Set();

  function rejectUpgrade(socket, status = "401 Unauthorized") {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  function handleUpgrade(request, socket, head) {
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${ingressToken}`) return rejectUpgrade(socket);
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  }

  wss.on("connection", (telnyx) => {
    const state = { telnyx, gemini: null, started: false, streamId: null, nextChunk: 1, buffered: new Map(), resampler: new Pcm16Resampler24To16(), closed: false };
    sessions.add(state);
    const geminiUrl = new URL(GEMINI_ENDPOINT); geminiUrl.searchParams.set("key", apiKey);
    const gemini = new WebSocket(geminiUrl, { perMessageDeflate: false });
    state.gemini = gemini;

    const closeBoth = () => {
      if (state.closed) return; state.closed = true; sessions.delete(state);
      try { if (telnyx.readyState === OPEN) telnyx.close(); } catch {}
      try { if (gemini.readyState === OPEN || gemini.readyState === 0) gemini.close(); } catch {}
    };
    const assertBackpressure = (socket, label) => { if (socket.bufferedAmount > maxBufferedBytes) throw new Error(`${label} backpressure limit exceeded`); };

    gemini.on("open", () => {
      try {
        safeSend(gemini, { setup: { model: options.model ?? "gemini-3.1-flash-live-preview", generationConfig: { responseModalities: ["AUDIO"] } } });
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
    gemini.on("error", closeBoth); gemini.on("close", closeBoth);

    telnyx.on("message", (raw) => {
      try {
        const message = parseJson(raw, "Telnyx media");
        const event = message?.event;
        if (event === "connected") return;
        if (event === "start") {
          if (state.started) throw new Error("Telnyx media start is one-shot");
          const format = message?.start?.media_format;
          if (format?.encoding !== "L16" || format?.sample_rate !== 16000 || format?.channels !== 1) throw new Error("Telnyx Gemini media requires mono L16 at 16000 Hz");
          state.streamId = required(message.stream_id, "Telnyx stream_id"); state.started = true; return;
        }
        if (!state.started) throw new Error("Telnyx media received before start");
        if (typeof message.stream_id === "string" && message.stream_id.trim() !== state.streamId) throw new Error("Telnyx media stream identity changed");
        if (event === "stop") return closeBoth();
        if (event !== "media" || message?.media?.track !== "inbound") return;
        const chunk = Number(message.media.chunk);
        if (!Number.isSafeInteger(chunk) || chunk < 1) throw new Error("Invalid Telnyx media chunk");
        const payload = required(message.media.payload, "Telnyx media payload");
        if (chunk < state.nextChunk) return;
        if (!state.buffered.has(chunk)) state.buffered.set(chunk, payload);
        if (state.buffered.size > 64) throw new Error("Telnyx media reorder window exceeded");
        while (state.buffered.has(state.nextChunk)) {
          const ordered = state.buffered.get(state.nextChunk); state.buffered.delete(state.nextChunk); state.nextChunk += 1;
          const pcm16le = swapPcm16Endianness(decodeBase64(ordered));
          assertBackpressure(gemini, "Gemini Live");
          safeSend(gemini, { realtimeInput: { audio: { data: encodeBase64(pcm16le), mimeType: "audio/pcm;rate=16000" } } });
        }
      } catch { closeBoth(); }
    });
    telnyx.on("error", closeBoth); telnyx.on("close", closeBoth);
  });

  return Object.freeze({
    wss,
    handleUpgrade,
    activeSessions: () => sessions.size,
    async close() { for (const session of [...sessions]) { try { session.telnyx.close(); session.gemini?.close(); } catch {} } await new Promise((resolve) => wss.close(() => resolve())); },
  });
}
