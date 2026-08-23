import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function secureTokenEqual(actualHeader, expectedToken) {
  const prefix = "Bearer ";
  if (typeof actualHeader !== "string" || !actualHeader.startsWith(prefix)) return false;
  const actual = Buffer.from(actualHeader.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function validUpstreamUrl(value) {
  const parsed = new URL(required(value, "benchmark upstream URL"));
  if (parsed.protocol === "wss:") return parsed.toString();
  const local = parsed.protocol === "ws:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (local) return parsed.toString();
  throw new Error("benchmark upstream URL must use wss:// except for localhost tests");
}

function closePair(left, right, code = 1011, reason = "benchmark relay closed") {
  if (left && left.readyState === WebSocket.OPEN) left.close(code, reason);
  if (right && right.readyState === WebSocket.OPEN) right.close(code, reason);
}

export function createGeminiMediaEdgeBenchmarkServer({
  mode,
  authToken,
  upstreamUrl = null,
  maxBufferedBytes = 1_048_576,
} = {}) {
  const normalizedMode = required(mode, "benchmark mode");
  if (normalizedMode !== "sink" && normalizedMode !== "relay") throw new Error("benchmark mode must be sink or relay");
  const token = required(authToken, "benchmark auth token");
  if (Buffer.byteLength(token) < 16) throw new Error("benchmark auth token must contain at least 16 bytes");
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
    throw new Error("benchmark maxBufferedBytes must be a positive safe integer");
  }
  const upstream = normalizedMode === "relay" ? validUpstreamUrl(upstreamUrl) : null;

  const server = http.createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, mode: normalizedMode }));
      return;
    }
    response.writeHead(404).end();
  });

  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try { pathname = new URL(request.url ?? "", "http://benchmark.local").pathname; } catch { /* fail below */ }
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!secureTokenEqual(request.headers.authorization, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
  });

  wss.on("connection", (client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));

    if (normalizedMode === "sink") {
      client.on("message", (data, isBinary) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > maxBufferedBytes) {
          client.close(1013, "benchmark sink backpressure");
          return;
        }
        client.send(data, { binary: isBinary });
      });
      return;
    }

    const upstreamSocket = new WebSocket(upstream, {
      headers: { authorization: `Bearer ${token}` },
      perMessageDeflate: false,
    });
    sockets.add(upstreamSocket);
    upstreamSocket.on("close", () => sockets.delete(upstreamSocket));

    const pending = [];
    let pendingBytes = 0;
    let upstreamReady = false;

    const enqueueOrSend = (data, isBinary) => {
      const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      if (!upstreamReady) {
        pendingBytes += size;
        if (pendingBytes > maxBufferedBytes) {
          closePair(client, upstreamSocket, 1013, "benchmark relay startup backpressure");
          return;
        }
        pending.push({ data, isBinary, size });
        return;
      }
      if (upstreamSocket.bufferedAmount > maxBufferedBytes) {
        closePair(client, upstreamSocket, 1013, "benchmark relay upstream backpressure");
        return;
      }
      upstreamSocket.send(data, { binary: isBinary });
    };

    client.on("message", enqueueOrSend);
    client.on("close", () => {
      if (upstreamSocket.readyState === WebSocket.OPEN || upstreamSocket.readyState === WebSocket.CONNECTING) upstreamSocket.close(1000);
    });
    client.on("error", () => closePair(client, upstreamSocket));

    upstreamSocket.on("open", () => {
      upstreamReady = true;
      for (const entry of pending.splice(0)) {
        if (upstreamSocket.bufferedAmount > maxBufferedBytes) {
          closePair(client, upstreamSocket, 1013, "benchmark relay upstream backpressure");
          return;
        }
        upstreamSocket.send(entry.data, { binary: entry.isBinary });
        pendingBytes -= entry.size;
      }
    });
    upstreamSocket.on("message", (data, isBinary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > maxBufferedBytes) {
        closePair(client, upstreamSocket, 1013, "benchmark relay client backpressure");
        return;
      }
      client.send(data, { binary: isBinary });
    });
    upstreamSocket.on("error", () => closePair(client, upstreamSocket));
    upstreamSocket.on("close", () => {
      if (client.readyState === WebSocket.OPEN) client.close(1000);
    });
  });

  return Object.freeze({
    server,
    mode: normalizedMode,
    async close() {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
      }
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  });
}
