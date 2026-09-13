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

function securityContext({ now, callControlId, sessionId }) {
  return {
    securityVersion: 1,
    sessionId,
    tenantId: "tenant-fast",
    routeId: "default",
    callControlId,
    callerPhoneE164: "+34647944762",
    calledPhoneE164: "+34910000001",
    provider: "TELNYX",
    createdAtEpochMs: now,
    notAfterEpochMs: now + 60_000,
  };
}

function securityClaims(context) {
  return {
    sessionId: context.sessionId,
    routeId: context.routeId,
    callerPhoneE164: context.callerPhoneE164,
    calledPhoneE164: context.calledPhoneE164,
    securityVersion: context.securityVersion,
  };
}

test("standalone fast server admits real Telnyx connected then start and starts only the fast Gemini session", async () => {
  const now = Date.now();
  const context = securityContext({ now, callControlId: "v3:fast-server", sessionId: "cs_fast-server" });
  const bootstrapRegistry = new InMemoryFastBootstrapRegistry();
  bootstrapRegistry.register({
    version: "gemini-fast-bootstrap.v2",
    credentialId: "cred-server-fast",
    tenantId: "tenant-fast",
    callControlId: "v3:fast-server",
    notAfterEpochMs: now + 60_000,
    securityContext: context,
    systemInstruction: "Responde brevemente.",
    tools: [],
  }, now);
  let gemini;
  let verifiedEdgeUrl = null;
  const runtime = createFastGeminiMediaServer({
    geminiApiKey: "test-api-key",
    controlToken: "0123456789abcdef0123456789abcdef",
    bootstrapRegistry,
    providerReadiness: { setupMs: 321, firstAudioMs: 654 },
    verifyCredential: async (_credential, _now, expectedEdgeUrl) => {
      verifiedEdgeUrl = expectedEdgeUrl;
      return {
        credentialId: "cred-server-fast",
        provider: "GEMINI",
        tenantId: "tenant-fast",
        callControlId: "v3:fast-server",
        ...securityClaims(context),
        edgeUrl: expectedEdgeUrl,
        targetLegs: "both",
        notAfterEpochMs: now + 60_000,
      };
    },
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
    diagnosticCalls: 0,
    providerReadiness: { setupMs: 321, firstAudioMs: 654 },
  });

  const client = new WebSocket(`ws://127.0.0.1:${port}/telnyx/gemini`, {
    headers: { "x-telnyx-streaming-auth-token": "opaque-test-credential" },
  });
  await once(client, "open");
  assert.equal(verifiedEdgeUrl, `wss://127.0.0.1:${port}/telnyx/gemini`);

  client.send(JSON.stringify({ event: "connected", version: "1.0.0" }));
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(gemini, undefined, "connected is protocol setup, not the authenticated media start");

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

  const unauthorizedDiagnostics = await fetch(`http://127.0.0.1:${port}/internal/diagnostics?call_control_id=${encodeURIComponent("v3:fast-server")}`);
  assert.equal(unauthorizedDiagnostics.status, 401);
  const diagnostics = await fetch(`http://127.0.0.1:${port}/internal/diagnostics?call_control_id=${encodeURIComponent("v3:fast-server")}`, {
    headers: { authorization: "Bearer 0123456789abcdef0123456789abcdef" },
  });
  assert.equal(diagnostics.status, 200);
  const diagnosticBody = await diagnostics.json();
  const stages = diagnosticBody.events.map((event) => event.stage);
  assert.deepEqual(stages.slice(0, 6), [
    "FAST_TELNYX_CONNECTED",
    "FAST_TELNYX_START_AUTHORIZED",
    "FAST_SESSION_STARTED",
    "FAST_MEDIA_AUTHORIZED",
    "GEMINI_SETUP_SENT",
    "GEMINI_SETUP_COMPLETE",
  ]);
  assert.equal(stages.includes("FAST_FIRST_CALLER_MEDIA"), true);
  assert.equal(stages.includes("CALLER_CHUNK_FORWARDED"), false, "per-audio-chunk events must not enter the diagnostic journal");
  assert.equal(stages.includes("GEMINI_FRAME_PROCESSED"), false, "per-provider-frame events must not enter the diagnostic journal");

  client.close();
  await runtime.close();
});

test("fast server rejects media before authenticated Telnyx start", async () => {
  const now = Date.now();
  const context = securityContext({ now, callControlId: "v3:fast-server-reject", sessionId: "cs_fast-server-reject" });
  const bootstrapRegistry = new InMemoryFastBootstrapRegistry();
  bootstrapRegistry.register({
    version: "gemini-fast-bootstrap.v2",
    credentialId: "cred-server-fast-reject",
    tenantId: "tenant-fast",
    callControlId: "v3:fast-server-reject",
    notAfterEpochMs: now + 60_000,
    securityContext: context,
    systemInstruction: "Responde brevemente.",
    tools: [],
  }, now);
  const runtime = createFastGeminiMediaServer({
    geminiApiKey: "test-api-key",
    controlToken: "0123456789abcdef0123456789abcdef",
    bootstrapRegistry,
    verifyCredential: async (_credential, _now, expectedEdgeUrl) => ({
      credentialId: "cred-server-fast-reject",
      provider: "GEMINI",
      tenantId: "tenant-fast",
      callControlId: "v3:fast-server-reject",
      ...securityClaims(context),
      edgeUrl: expectedEdgeUrl,
      targetLegs: "both",
      notAfterEpochMs: now + 60_000,
    }),
  });
  const port = await listen(runtime.server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/telnyx/gemini`, {
    headers: { "x-telnyx-streaming-auth-token": "opaque-test-credential" },
  });
  await once(client, "open");
  client.send(JSON.stringify({ event: "connected", version: "1.0.0" }));
  client.send(JSON.stringify({ event: "media", media: { track: "inbound", chunk: 1, payload: "AAAA" } }));
  const [code] = await once(client, "close");
  assert.equal(code, 1008);
  assert.equal(runtime.activeSessions(), 0);
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
  assert.equal(body.providerReadiness, null);
  assert.equal(body.diagnosticCalls, 0);
  assert.equal("semanticDecision" in body, false);
  assert.equal("speech" in body, false);
  await runtime.close();
});
