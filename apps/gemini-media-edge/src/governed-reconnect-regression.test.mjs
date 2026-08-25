import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { InMemoryControlSidebandRegistry } from "./control-sideband.mjs";
import { classifyTelnyxMessageFailure, createGeminiMediaEdgeRuntime } from "./runtime-core.mjs";

const claims = Object.freeze({
  credentialId: "credential-governed-reconnect-1",
  provider: "GEMINI",
  tenantId: "tenant-governed-reconnect",
  callControlId: "call-governed-reconnect",
  edgeUrl: "wss://media.example.test/telnyx/gemini",
  targetLegs: "self",
  notAfterEpochMs: 2_000_000_000_000,
});

const bootstrap = Object.freeze({
  credentialId: claims.credentialId,
  tenantId: claims.tenantId,
  callControlId: claims.callControlId,
  notAfterEpochMs: claims.notAfterEpochMs,
  instructions: "Eres Lucía. [AUTHORITATIVE_NOW_V48] Europe/Madrid.",
  tools: [{
    type: "function",
    name: "restaurant_reservation_create",
    description: "Crea una reserva.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
  }],
  manualActivityDetection: true,
  manualActivityHandling: "START_OF_ACTIVITY_INTERRUPTS",
});

class FakeGeminiSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
  }
  open() { this.readyState = 1; this.emit("open"); }
  send(value) { this.sent.push(JSON.parse(value)); }
  receive(value) { this.emit("message", JSON.stringify(value)); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

test("local input detection restore survives deterministic provider reconnect until governed playback drains", async () => {
  const diagnostics = [];
  const controlFrames = [];
  const telnyxFrames = [];
  const registry = new InMemoryControlSidebandRegistry();
  const geminiSockets = [];
  let gemini = null;

  const controlAttachment = registry.attach(claims, (frame) => {
    controlFrames.push(frame);
    return true;
  });

  const runtime = createGeminiMediaEdgeRuntime({
    geminiApiKey: "synthetic-api-key-never-sent",
    verifyCredential: async (credential) => {
      assert.equal(credential, "synthetic-governed-reconnect-credential");
      return claims;
    },
    consumeCredentialOnce: async () => true,
    consumeBootstrapForClaims: async () => bootstrap,
    bindControlSession: (identity, sink) => registry.bindCommandSink(identity, sink),
    isControlSessionActive: (identity) => registry.isActive(identity),
    emitControlEvent: (identity, frame) => registry.emit(identity, frame),
    observeDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    semanticPreselect: async () => ({ selectedTool: "restaurant_reservation_create", directModelOutputAllowed: false }),
    authoritativeTranscribe: async ({ itemId }) => ({ itemId, transcript: "mañana a las ocho para dos" }),
    synthesizeGovernedSpeech: async ({ text }) => ({
      text,
      pcm16le: Buffer.from([0x01, 0x02, 0x03, 0x04]),
      sampleRateHertz: 16_000,
      encoding: "PCM16_LE",
    }),
    callerVadConfig: { startRms: 0.2, stopRms: 0.05, minSpeechMs: 40, minSilenceMs: 40 },
    createGeminiSocket: () => {
      gemini = new FakeGeminiSocket();
      geminiSockets.push(gemini);
      return gemini;
    },
  });

  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => { void runtime.handleUpgrade(request, socket, head); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const telnyx = new WebSocket(`ws://127.0.0.1:${address.port}/media`, {
    headers: { "x-telnyx-streaming-auth-token": "synthetic-governed-reconnect-credential" },
  });
  telnyx.on("message", (raw) => telnyxFrames.push(JSON.parse(raw.toString("utf8"))));

  try {
    await once(telnyx, "open");
    telnyx.send(JSON.stringify({
      event: "start",
      stream_id: "stream-governed-reconnect-1",
      start: {
        call_control_id: claims.callControlId,
        media_format: { encoding: "L16", sample_rate: 16_000, channels: 1 },
      },
    }));
    await eventually(() => gemini, "Initial Gemini socket was not created");
    gemini.open();
    gemini.receive({ setupComplete: {} });
    await eventually(() => registry.isActive(claims), "Control sideband did not become active");

    const oldResponseId = "deterministic-provider-response-1";
    await registry.command(claims, { type: "PLAYBACK_BINDING", responseId: oldResponseId, kind: "NORMAL" });
    await registry.command(claims, {
      type: "DETERMINISTIC_TOOL_BYPASS",
      callId: "reservation-tool-1",
      toolName: "restaurant_reservation_create",
      responseId: oldResponseId,
      continuationContext: "RESERVATION_PARTY_SIZE",
    });

    assert.equal(geminiSockets.length, 2);
    const replacementGemini = geminiSockets[1];
    assert.equal(replacementGemini.readyState, 0);
    assert.equal(controlFrames.some((frame) => frame.type === "PROVIDER_SESSION_RESET"), true);

    const governedResponseId = "governed-deterministic-response-regression-1";
    await registry.command(claims, {
      type: "GOVERNED_SPEECH",
      responseId: governedResponseId,
      text: "Indica fecha, hora y número de personas.",
      purpose: "gemini_deterministic_reservation_state_v56",
    });
    await eventually(
      () => controlFrames.find((frame) => frame.type === "PLAYBACK_EVENT"
        && frame.event.type === "ASSISTANT_AUDIO_STARTED"
        && frame.event.responseId === governedResponseId),
      "Governed playback did not start before replacement setup",
    );
    assert.equal(replacementGemini.readyState, 0);

    // This is the production race: V40 restores listening as soon as governed
    // audio starts, while the replacement Gemini socket is still connecting.
    await registry.command(claims, { type: "INPUT_DETECTION_RESTORE" });
    await eventually(
      () => controlFrames.find((frame) => frame.type === "INPUT_DETECTION_EVENT"
        && frame.event.type === "INPUT_DETECTION_UPDATED"
        && frame.event.present === true),
      "Local input detection restore was not acknowledged during provider reconnect",
    );
    assert.equal(runtime.activeSessions(), 1);
    assert.equal(diagnostics.some((entry) => entry.stage === "MEDIA_SESSION_CLOSING"), false);

    replacementGemini.open();
    replacementGemini.receive({ setupComplete: {} });
    await eventually(
      () => diagnostics.some((entry) => entry.stage === "GEMINI_SETUP_COMPLETE" && entry.providerEpoch === 2),
      "Replacement Gemini setup did not complete",
    );

    const mark = await eventually(
      () => telnyxFrames.find((frame) => frame.event === "mark"),
      "Governed playback drain mark was not emitted",
    );
    telnyx.send(JSON.stringify({
      event: "mark",
      stream_id: "stream-governed-reconnect-1",
      mark: mark.mark,
    }));

    await eventually(
      () => controlFrames.find((frame) => frame.type === "GOVERNED_EVENT"
        && frame.event.type === "ASSISTANT_RESPONSE_COMPLETED"
        && frame.event.responseId === governedResponseId),
      "Governed response did not complete after replacement setup",
    );
    assert.equal(runtime.activeSessions(), 1);
    assert.equal(diagnostics.some((entry) => entry.stage === "GOVERNED_PLAYBACK_MARK_MATCHED"
      && entry.responseId === governedResponseId), true);
    assert.equal(diagnostics.some((entry) => entry.stage === "GOVERNED_PLAYBACK_COMPLETED"
      && entry.responseId === governedResponseId), true);
    assert.equal(diagnostics.some((entry) => entry.stage === "TELNYX_MESSAGE_REJECTED"), false);
    assert.equal(diagnostics.some((entry) => entry.stage === "MEDIA_SESSION_CLOSING"), false);

    telnyx.send(JSON.stringify({ event: "stop", stream_id: "stream-governed-reconnect-1" }));
    await eventually(() => runtime.activeSessions() === 0, "Media session did not close after Telnyx stop");
  } finally {
    try { telnyx.close(); } catch {}
    if (registry.size()) controlAttachment.detach();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Telnyx completion failures expose stable categories without raw payloads", () => {
  assert.equal(classifyTelnyxMessageFailure(new Error("Governed speech completion context is missing")), "GOVERNED_COMPLETION_CONTEXT_MISSING");
  assert.equal(classifyTelnyxMessageFailure(new Error("Governed speech completion identity mismatch")), "GOVERNED_COMPLETION_IDENTITY_MISMATCH");
  assert.equal(classifyTelnyxMessageFailure(new Error("Governed speech completion has no active ownership")), "GOVERNED_COMPLETION_OWNERSHIP_MISSING");
  assert.equal(classifyTelnyxMessageFailure(new Error("Governed speech playback completion requires active control sideband")), "GOVERNED_PLAYBACK_SIDEBAND_INACTIVE");
  assert.equal(classifyTelnyxMessageFailure(new Error("Governed speech response completion requires active control sideband")), "GOVERNED_RESPONSE_SIDEBAND_INACTIVE");
  assert.equal(classifyTelnyxMessageFailure(new Error("unclassified internal detail")), "TELNYX_MESSAGE_INVALID");
});
