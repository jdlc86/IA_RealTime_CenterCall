import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createGeminiMediaEdgeBenchmarkServer } from "./relay.mjs";

const TOKEN = "benchmark-token-0123456789";

async function listen(runtime) {
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  return `ws://127.0.0.1:${address.port}/ws`;
}

function connect(url, token = TOKEN) {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
    perMessageDeflate: false,
  });
}

async function open(socket) {
  if (socket.readyState === WebSocket.OPEN) return;
  await once(socket, "open");
}

test("sink rejects unauthenticated websocket upgrades", async (t) => {
  const runtime = createGeminiMediaEdgeBenchmarkServer({ mode: "sink", authToken: TOKEN });
  t.after(() => runtime.close());
  const url = await listen(runtime);
  const socket = connect(url, "wrong-token-0123456789");
  const [error] = await once(socket, "error");
  assert.match(error.message, /401/);
});

test("sink echoes binary frames without changing bytes", async (t) => {
  const runtime = createGeminiMediaEdgeBenchmarkServer({ mode: "sink", authToken: TOKEN });
  t.after(() => runtime.close());
  const url = await listen(runtime);
  const socket = connect(url);
  t.after(() => socket.terminate());
  await open(socket);

  const payload = Buffer.from([0, 1, 2, 127, 128, 255]);
  socket.send(payload);
  const [data, isBinary] = await once(socket, "message");
  assert.equal(isBinary, true);
  assert.deepEqual(Buffer.from(data), payload);
});

test("relay forwards bidirectionally through an authenticated sink", async (t) => {
  const sink = createGeminiMediaEdgeBenchmarkServer({ mode: "sink", authToken: TOKEN });
  t.after(() => sink.close());
  const sinkUrl = await listen(sink);

  const relay = createGeminiMediaEdgeBenchmarkServer({
    mode: "relay",
    authToken: TOKEN,
    upstreamUrl: sinkUrl,
  });
  t.after(() => relay.close());
  const relayUrl = await listen(relay);

  const socket = connect(relayUrl);
  t.after(() => socket.terminate());
  await open(socket);
  const payload = Buffer.from("relay-payload");
  socket.send(payload);
  const [data, isBinary] = await once(socket, "message");
  assert.equal(isBinary, true);
  assert.deepEqual(Buffer.from(data), payload);
});

test("relay allows insecure upstream only for localhost benchmark tests", () => {
  assert.throws(
    () => createGeminiMediaEdgeBenchmarkServer({
      mode: "relay",
      authToken: TOKEN,
      upstreamUrl: "ws://example.com/ws",
    }),
    /must use wss:\/\//,
  );
});

test("health endpoint never exposes auth token or upstream URL", async (t) => {
  const runtime = createGeminiMediaEdgeBenchmarkServer({ mode: "sink", authToken: TOKEN });
  t.after(() => runtime.close());
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(body.includes(TOKEN), false);
  assert.deepEqual(JSON.parse(body), { ok: true, mode: "sink" });
});
