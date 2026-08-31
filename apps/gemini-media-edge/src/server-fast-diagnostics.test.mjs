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
  close(code = 1000) { this.readyState = 3; this.emit("close", code); }
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

test("post-call diagnostic persistence is fire-and-forget and cannot hold the fast session open", async () => {
  const now = Date.now();
  const securityContext = Object.freeze({
    securityVersion: 1,
    sessionId: "cs_diagnostic-nonblocking",
    tenantId: "restaurante-centro",
    routeId: "default",
    callControlId: "v3:diagnostic-nonblocking",
    callerPhoneE164: "+34647944762",
    calledPhoneE164: "+34910000001",
    provider: "TELNYX",
    createdAtEpochMs: now,
    notAfterEpochMs: now + 60_000,
  });
  const bootstrapRegistry = new InMemoryFastBootstrapRegistry();
  bootstrapRegistry.register({
    version: "gemini-fast-bootstrap.v2",
    credentialId: "cred-diagnostic-nonblocking",
    tenantId: "restaurante-centro",
    callControlId: "v3:diagnostic-nonblocking",
    notAfterEpochMs: now + 60_000,
    securityContext,
    systemInstruction: "Responde brevemente.",
    tools: [],
  }, now);

  let gemini;
  let flushedEvents = null;
  let flushCalled = false;
  const neverResolvingFlush = (events) => {
    flushCalled = true;
    flushedEvents = events;
    return new Promise(() => {});
  };

  const runtime = createFastGeminiMediaServer({
    geminiApiKey: "test-api-key",
    controlToken: "0123456789abcdef0123456789abcdef",
    bootstrapRegistry,
    flushDiagnostics: neverResolvingFlush,
    verifyCredential: async (_credential, _now, expectedEdgeUrl) => ({
      credentialId: "cred-diagnostic-nonblocking",
      provider: "GEMINI",
      tenantId: "restaurante-centro",
      callControlId: "v3:diagnostic-nonblocking",
      sessionId: securityContext.sessionId,
      routeId: securityContext.routeId,
      callerPhoneE164: securityContext.callerPhoneE164,
      calledPhoneE164: securityContext.calledPhoneE164,
      securityVersion: securityContext.securityVersion,
      edgeUrl: expectedEdgeUrl,
      targetLegs: "both",
      notAfterEpochMs: now + 60_000,
    }),
    createGeminiSocket() { gemini = new FakeGeminiSocket(); return gemini; },
  });

  const port = await listen(runtime.server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/telnyx/gemini`, {
    headers: { "x-telnyx-streaming-auth-token": "opaque-test-credential" },
  });
  await once(client, "open");
  client.send(JSON.stringify({ event: "connected", version: "1.0.0" }));
  client.send(JSON.stringify({
    event: "start",
    stream_id: "stream-diagnostic-nonblocking",
    start: {
      call_control_id: "v3:diagnostic-nonblocking",
      media_format: { encoding: "L16", sample_rate: 16000, channels: 1 },
    },
  }));
  for (let i = 0; i < 20 && !gemini; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(gemini);
  gemini.open();
  gemini.message({ setupComplete: {} });
  assert.equal(runtime.activeSessions(), 1);

  const closed = once(client, "close");
  client.send(JSON.stringify({ event: "stop" }));
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("call close waited for diagnostic persistence")), 100)),
  ]);

  for (let i = 0; i < 20 && !flushCalled; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(runtime.activeSessions(), 0, "session ownership must be released before persistence resolves");
  assert.equal(flushCalled, true);
  assert.ok(Array.isArray(flushedEvents));
  assert.equal(flushedEvents.at(-1).stage, "FAST_SESSION_CLOSED");
  assert.equal(flushedEvents.some((event) => event.stage === "CALLER_CHUNK_FORWARDED"), false);
  assert.equal(flushedEvents.some((event) => event.stage === "GEMINI_FRAME_PROCESSED"), false);

  await runtime.close();
});
