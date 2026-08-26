import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { InMemoryFastBootstrapRegistry } from "./fast-bootstrap.mjs";
import { createFastGeminiMediaServer } from "./server-fast.mjs";

class FakeGeminiSocket {
  constructor() {
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.listeners = new Map();
    this.sent = [];
    this.closed = null;
  }
  on(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    return this;
  }
  emit(type, value) { for (const listener of this.listeners.get(type) ?? []) listener(value); }
  open() { this.readyState = 1; this.emit("open"); }
  send(value) { this.sent.push(typeof value === "string" ? JSON.parse(value) : value); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
  message(value) { this.emit("message", JSON.stringify(value)); }
}

function once(target, event) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { cleanup(); reject(error); };
    const onEvent = (...args) => { cleanup(); resolve(args); };
    const cleanup = () => {
      target.off?.(event, onEvent);
      target.off?.("error", onError);
    };
    target.on(event, onEvent);
    target.on("error", onError);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return address.port;
}

test("standalone fast server admits Telnyx media and starts only the fast Gemini session", async () => {
  const now = Date.now();
  const bootstrapRegistry = new InMemoryFastBootstrapRegistry();
  bootstrapRegistry.register({
    credentialId: "cred-server-fast",
    tenantId: "tenant-fast",
    callControlId: "v3:fast-server",
    notAfterEpochMs: now + 60_000,
    systemInstruction: "Responde brevemente.",
    tools: [],
  }, now);
  let gemini;
  const runtime = createFastGeminiMediaServer({
    geminiApiKey: "test-api-key",
    controlToken: "0123456789abcdef0123456789abcdef",
    bootstrapRegistry,
    verifyCredential: async () => ({
      credentialId: "cred-server-fast",
      provider: "GEMINI",
      tenantId: "tenant-fast",
      callControlId: "v3:fast-server",
      edgeUrl: "wss://example.invalid/telnyx/gemini",
      targetLegs: "both",
      notAfterEpochMs: now + 60_000,
    }),
    createGeminiSocket() { gemini = new FakeGeminiSocket(); return gemini; },
  });

  const port = await listen(runtime.server);
  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    ok: true,
    service: "gemini-media-edge-fast",
    model: "gemini-3.1-flash-live-preview",
    revision: null,
    activeSessions: 0,
    registeredBootstraps: 1,
  });

  const client = new WebSocket(`ws://127.0.0.1:${port}/telnyx/gemini`, {
    headers: { "x-telnyx-streaming-auth-token": "opaque-test-credential" },
  });
  await once(client, "open");
  client.send(JSON.stringify({
    event: "start",
    stream_id: "stream-fast-1",
    start: {
      call_control_id: "v3:fast-server",
      media_format: { encoding: "L16", sample_rate: 16000, channels: 1 },
    },
  }));

  for (let i = 0; i < 20 && !gemini; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(gemini, "fast Gemini socket should be created after authorized Telnyx start");
  gemini.open();
  assert.equal(gemini.sent[0].setup.model, "models/gemini-3.1-flash-live-preview");
  gemini.message({ setupComplete: {} });

  client.send(JSON.stringify({
    event: "media",
    media: { track: "inbound", chunk: 1, payload: Buffer.alloc(640).toString("base64") },
  }));
  for (let i = 0; i < 20 && gemini.sent.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(gemini.sent[1].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(runtime.activeSessions(), 1);

  client.close();
  await runtime.close();
});

test("fast server bootstrap endpoint is authenticated and contains no semantic readiness gate", async () => {
  const runtime = createFastGeminiMediaServer({
    geminiApiKey: "test-api-key",
    controlToken: "0123456789abcdef0123456789abcdef",
    verifyCredential: async () => { throw new Error("unused"); },
  });
  const port = await listen(runtime.server);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/internal/bootstrap`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);

  const ready = await fetch(`http://127.0.0.1:${port}/ready`);
  const body = await ready.json();
  assert.equal(body.ok, true);
  assert.equal("semanticDecision" in body, false);
  assert.equal("speech" in body, false);
  await runtime.close();
});
