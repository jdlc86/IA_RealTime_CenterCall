import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { InMemoryControlSidebandRegistry } from "./control-sideband.mjs";
import { createGeminiMediaEdgeRuntime } from "./runtime.mjs";

const claims = Object.freeze({
  credentialId: "credential-synthetic-1",
  provider: "GEMINI",
  tenantId: "tenant-synthetic",
  callControlId: "call-synthetic",
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
    name: "restaurant_business_info",
    description: "Consulta información pública del restaurante.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
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

function audioFrame(sample, samples = 320) {
  const bytes = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) bytes.writeInt16LE(sample, index * 2);
  return bytes.toString("base64");
}

function providerAudio(samples = 480) {
  const bytes = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) bytes.writeInt16LE(index % 2 ? 2_000 : -2_000, index * 2);
  return bytes.toString("base64");
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

test("synthetic media E2E traces authorized caller audio, tools, playout and governed cleanup", async () => {
  const trace = [];
  const diagnostics = [];
  const controlFrames = [];
  const telnyxFrames = [];
  const registry = new InMemoryControlSidebandRegistry();
  let gemini = null;
  const geminiSockets = [];
  let credentialConsumptions = 0;
  let bootstrapConsumptions = 0;
  let transcriptionAttempts = 0;

  const controlAttachment = registry.attach(claims, (frame) => {
    controlFrames.push(frame);
    if (frame.type === "CALLER_EVENT" && frame.event.type === "CALLER_SPEECH_STARTED") {
      trace.push({ stage: "CALLER_ITEM_STARTED", itemId: frame.event.itemId });
    }
    if (frame.type === "CALLER_EVENT" && frame.event.type === "CALLER_TRANSCRIPT_COMPLETED") {
      trace.push({ stage: "CALLER_TRANSCRIPT_READY", itemId: frame.event.itemId });
    }
    if (frame.type === "GEMINI_EVENT" && frame.message.toolCall) {
      const call = frame.message.toolCall.functionCalls[0];
      trace.push({ stage: "TOOL_SELECTED", callId: call.id, toolName: call.name });
    }
    if (frame.type === "PLAYBACK_EVENT") {
      trace.push({ stage: frame.event.type, responseId: frame.event.responseId, kind: frame.event.kind });
    }
    if (frame.type === "GOVERNED_EVENT") {
      trace.push({ stage: frame.event.type, responseId: frame.event.responseId, kind: frame.event.kind });
    }
    return true;
  });
  let preMediaCommandSettled = false;
  const preMediaCommand = registry.command(claims, { type: "INPUT_DETECTION_SUSPEND" })
    .finally(() => { preMediaCommandSettled = true; });

  const runtime = createGeminiMediaEdgeRuntime({
    geminiApiKey: "synthetic-api-key-never-sent",
    verifyCredential: async (credential) => {
      assert.equal(credential, "synthetic-media-credential");
      return claims;
    },
    consumeCredentialOnce: async () => { credentialConsumptions += 1; return true; },
    consumeBootstrapForClaims: async () => { bootstrapConsumptions += 1; return bootstrap; },
    bindControlSession: (identity, sink) => registry.bindCommandSink(identity, sink),
    isControlSessionActive: (identity) => registry.isActive(identity),
    emitControlEvent: (identity, frame) => registry.emit(identity, frame),
    observeDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    semanticPreselect: async ({ claims: identity, bootstrap: activeBootstrap, transcript }) => {
      assert.equal(identity.tenantId, claims.tenantId);
      assert.equal(identity.callControlId, claims.callControlId);
      assert.equal(activeBootstrap, bootstrap);
      assert.equal(transcript, "¿A qué hora abren?");
      return { selectedTool: "restaurant_business_info", directModelOutputAllowed: false };
    },
    authoritativeTranscribe: async (request) => {
      transcriptionAttempts += 1;
      if (transcriptionAttempts === 1) return { itemId: request.itemId, transcript: "¿A qué hora abren?" };
      throw new Error("Google Speech returned no transcript");
    },
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
    headers: { "x-telnyx-streaming-auth-token": "synthetic-media-credential" },
  });
  telnyx.on("message", (raw) => { telnyxFrames.push(JSON.parse(raw.toString("utf8"))); });

  try {
    await once(telnyx, "open");
    trace.push({ stage: "MEDIA_SOCKET_AUTHORIZED", tenantId: claims.tenantId, callControlId: claims.callControlId });
    telnyx.send(JSON.stringify({
      event: "start",
      stream_id: "stream-synthetic-1",
      start: {
        call_control_id: claims.callControlId,
        media_format: { encoding: "L16", sample_rate: 16_000, channels: 1 },
      },
    }));
    await eventually(() => gemini, "Gemini socket was not created after authorized media start");
    assert.equal(registry.isActive(claims), false);
    assert.equal(preMediaCommandSettled, false);

    gemini.open();
    assert.equal(gemini.sent.length, 1);
    assert.equal(gemini.sent[0].setup.model, "models/gemini-3.1-flash-live-preview");
    assert.equal("parametersJsonSchema" in gemini.sent[0].setup.tools[0].functionDeclarations[0], true);
    assert.equal("parameters" in gemini.sent[0].setup.tools[0].functionDeclarations[0], false);
    assert.equal(gemini.sent[0].setup.systemInstruction.parts[0].text, bootstrap.instructions);
    assert.equal(registry.isActive(claims), false);
    assert.equal(preMediaCommandSettled, false);
    gemini.receive({ setupComplete: {} });
    await preMediaCommand;
    assert.equal(registry.isActive(claims), true);
    assert.equal(preMediaCommandSettled, true);
    assert.deepEqual(controlFrames.find((frame) => frame.type === "INPUT_DETECTION_EVENT"), {
      type: "INPUT_DETECTION_EVENT",
      event: { type: "INPUT_DETECTION_UPDATED", present: true, settings: null },
    });
    registry.command(claims, { type: "INPUT_DETECTION_RESTORE" });
    trace.push({ stage: "SIDEBAND_AND_MEDIA_ATTACHED", tenantId: claims.tenantId, callControlId: claims.callControlId });

    const voiced = audioFrame(12_000);
    const silence = audioFrame(0);
    for (const [index, payload] of [voiced, voiced, silence, silence].entries()) {
      telnyx.send(JSON.stringify({
        event: "media",
        stream_id: "stream-synthetic-1",
        media: { track: "inbound", chunk: String(index + 1), payload },
      }));
    }
    const transcriptFrame = await eventually(
      () => controlFrames.find((frame) => frame.type === "CALLER_EVENT" && frame.event.type === "CALLER_TRANSCRIPT_COMPLETED"),
      "Authoritative caller transcript was not emitted",
    );
    const itemId = transcriptFrame.event.itemId;

    await registry.command(claims, { type: "CALLER_TURN_DECISION", itemId, decision: "NORMAL", responseId: null });
    trace.push({ stage: "CALLER_ITEM_COMMITTED", itemId, disposition: "NORMAL" });
    await registry.command(claims, { type: "SEMANTIC_GATE_ARM" });
    trace.push({ stage: "SEMANTIC_GATE_ARMED", itemId });
    const committedCallerFrames = gemini.sent.slice(1).map((message) => Object.keys(message.realtimeInput)[0]);
    assert.equal(committedCallerFrames[0], "activityStart");
    assert.equal(committedCallerFrames.at(-1), "activityEnd");
    assert.ok(committedCallerFrames.slice(1, -1).length > 0);
    assert.equal(committedCallerFrames.slice(1, -1).every((type) => type === "audio"), true);

    // Gemini Live can occasionally answer a governed route directly even after
    // correct preselection. Suppress that audio and retry once for the exact
    // preselected function, preserving a real provider-generated call id.
    gemini.receive({ serverContent: { modelTurn: { parts: [{
      inlineData: { mimeType: "audio/pcm;rate=24000", data: providerAudio() },
    }] } } });
    assert.equal(telnyxFrames.some((frame) => frame.event === "media"), false);
    const compatibilityRetry = gemini.sent.at(-1).clientContent;
    assert.equal(compatibilityRetry.turnComplete, true);
    assert.equal(compatibilityRetry.turns[0].parts[0].text.includes("restaurant_business_info"), true);
    assert.equal(compatibilityRetry.turns[0].parts[0].text.includes("¿A qué hora abren?"), false);
    assert.equal(diagnostics.some((entry) => entry.stage === "SEMANTIC_TOOL_RETRY_REQUESTED"), true);
    assert.equal(diagnostics.some((entry) => entry.stage === "MEDIA_SESSION_CLOSING"), false);
    gemini.receive({ serverContent: { turnComplete: true } });

    gemini.receive({ toolCall: { functionCalls: [{
      id: "business-info-synthetic-1",
      name: "restaurant_business_info",
      args: { topics: ["HOURS"] },
    }] } });
    await eventually(
      () => controlFrames.find((frame) => frame.type === "GEMINI_EVENT" && frame.message.toolCall),
      "Semantic tool selection was not emitted",
    );
    registry.command(claims, { type: "SEMANTIC_GATE_RELEASE" });
    trace.push({ stage: "SEMANTIC_GATE_RELEASED", itemId });
    registry.command(claims, {
      type: "TOOL_RESULT",
      callId: "business-info-synthetic-1",
      toolName: "restaurant_business_info",
      output: { ok: true, status: "FOUND" },
    });
    trace.push({ stage: "TOOL_RESULT_DELIVERED", callId: "business-info-synthetic-1" });
    assert.deepEqual(gemini.sent.at(-1).toolResponse.functionResponses[0], {
      id: "business-info-synthetic-1",
      name: "restaurant_business_info",
      response: { result: { ok: true, status: "FOUND" } },
    });

    // Reproduce the real post-tool ordering: the provider may produce audio
    // before or after its response binding, while the Control Plane has already
    // selected exact governed speech. Provider audio stays silent, the governed
    // command waits for the real provider completion, and then takes playback.
    gemini.receive({ serverContent: { modelTurn: { parts: [{
      inlineData: { mimeType: "audio/pcm;rate=24000", data: providerAudio() },
    }] } } });
    registry.command(claims, { type: "PLAYBACK_BINDING", responseId: "normal-response-synthetic-1", kind: "NORMAL" });
    assert.equal(telnyxFrames.some((frame) => frame.event === "media"), false);
    const governedPostTool = registry.command(claims, {
      type: "GOVERNED_SPEECH",
      responseId: "normal-response-synthetic-1",
      text: "Abrimos a las nueve.",
    });
    gemini.receive({ serverContent: { turnComplete: true } });
    await registry.command(claims, { type: "PLAYBACK_DRAIN", responseId: "normal-response-synthetic-1" });
    await governedPostTool;
    const normalMedia = await eventually(
      () => telnyxFrames.find((frame) => frame.event === "media"),
      "Governed post-tool audio did not reach Telnyx playback",
    );
    assert.deepEqual([...Buffer.from(normalMedia.media.payload, "base64")], [0x01, 0x02, 0x03, 0x04]);
    const normalMark = await eventually(
      () => telnyxFrames.find((frame) => frame.event === "mark"),
      "Governed post-tool playback drain mark was not emitted",
    );
    telnyx.send(JSON.stringify({ event: "mark", stream_id: "stream-synthetic-1", mark: normalMark.mark }));
    await eventually(
      () => controlFrames.find((frame) => frame.type === "PLAYBACK_EVENT" && frame.event.type === "ASSISTANT_AUDIO_STOPPED" && frame.event.responseId === "normal-response-synthetic-1"),
      "Normal playback completion was not correlated",
    );

    // A deterministic reservation result must not be submitted to the old
    // BLOCKING Gemini session. Rotate the provider session before any provider
    // audio exists, acknowledge the exact tool/response identities, and let
    // governed speech start while the replacement session is connecting.
    const previousGemini = gemini;
    previousGemini.receive({ toolCall: { functionCalls: [{
      id: "reservation-tool-synthetic-1",
      name: "restaurant_business_info",
      args: { topics: ["HOURS"] },
    }] } });
    await eventually(
      () => controlFrames.find((frame) => frame.type === "GEMINI_EVENT" && frame.message.toolCall?.functionCalls?.[0]?.id === "reservation-tool-synthetic-1"),
      "Deterministic tool call was not emitted",
    );
    await registry.command(claims, {
      type: "PLAYBACK_BINDING",
      responseId: "deterministic-response-synthetic-1",
      kind: "NORMAL",
    });
    const previousSentCount = previousGemini.sent.length;
    await registry.command(claims, {
      type: "DETERMINISTIC_TOOL_BYPASS",
      callId: "reservation-tool-synthetic-1",
      toolName: "restaurant_business_info",
      responseId: "deterministic-response-synthetic-1",
      continuationContext: "RESERVATION_CONFIRMATION",
    });
    assert.equal(geminiSockets.length, 2);
    assert.notEqual(gemini, previousGemini);
    assert.equal(previousGemini.sent.length, previousSentCount);
    assert.equal(previousGemini.sent.some((message) =>
      message.toolResponse?.functionResponses?.some((response) => response.id === "reservation-tool-synthetic-1")), false);
    assert.deepEqual(
      controlFrames.find((frame) => frame.type === "PROVIDER_SESSION_RESET"),
      {
        type: "PROVIDER_SESSION_RESET",
        event: {
          callId: "reservation-tool-synthetic-1",
          responseId: "deterministic-response-synthetic-1",
          continuationContext: "RESERVATION_CONFIRMATION",
        },
      },
    );
    assert.equal(diagnostics.some((entry) =>
      entry.stage === "DETERMINISTIC_POST_TOOL_PROVIDER_RESET"
      && entry.postToolModelGenerations === 0
      && entry.postToolDiscardedModelOutput === 0
      && entry.playbackAuthorities === 1), true);

    const mediaBeforeDeterministicSpeech = telnyxFrames.filter((frame) => frame.event === "media").length;
    await registry.command(claims, {
      type: "GOVERNED_SPEECH",
      responseId: "deterministic-response-synthetic-1",
      text: "Perfecto, ¿confirmas la reserva?",
      purpose: "gemini_deterministic_reservation_state_v56",
    });
    const deterministicMedia = await eventually(
      () => telnyxFrames.filter((frame) => frame.event === "media")[mediaBeforeDeterministicSpeech],
      "Deterministic governed speech did not start during Gemini reconnect",
    );
    const latencyDiagnostic = diagnostics.find((entry) => entry.stage === "DETERMINISTIC_SPEECH_END_TO_AUDIO_START");
    assert.ok(latencyDiagnostic);
    assert.equal(Number.isSafeInteger(latencyDiagnostic.observedMs), true);
    assert.equal(latencyDiagnostic.p50Ms, latencyDiagnostic.observedMs);
    assert.equal(latencyDiagnostic.p95Ms, latencyDiagnostic.observedMs);
    assert.equal(latencyDiagnostic.overBudget, false);
    assert.deepEqual([...Buffer.from(deterministicMedia.media.payload, "base64")], [0x01, 0x02, 0x03, 0x04]);
    assert.equal(telnyxFrames.filter((frame) => frame.event === "media").length, mediaBeforeDeterministicSpeech + 1);
    const deterministicMark = await eventually(
      () => telnyxFrames.filter((frame) => frame.event === "mark").find((frame) =>
        frame.mark.name !== normalMark.mark.name),
      "Deterministic governed playback drain mark was not emitted",
    );
    telnyx.send(JSON.stringify({ event: "mark", stream_id: "stream-synthetic-1", mark: deterministicMark.mark }));
    await eventually(
      () => controlFrames.find((frame) => frame.type === "GOVERNED_EVENT" && frame.event.type === "ASSISTANT_RESPONSE_COMPLETED" && frame.event.responseId === "deterministic-response-synthetic-1"),
      "Deterministic governed playback completion was not correlated",
    );

    gemini.open();
    assert.equal(gemini.sent.length, 1);
    const replacementInstruction = gemini.sent[0].setup.systemInstruction.parts[0].text;
    assert.equal(replacementInstruction.startsWith(bootstrap.instructions), true);
    assert.equal(replacementInstruction.includes("waiting for explicit confirmation"), true);
    assert.equal(replacementInstruction.includes("Perfecto, ¿confirmas la reserva?"), false);
    gemini.receive({ setupComplete: {} });
    await eventually(
      () => diagnostics.some((entry) => entry.stage === "GEMINI_SETUP_COMPLETE" && entry.providerEpoch === 2),
      "Replacement Gemini session did not complete setup",
    );

    const beforeEmptyCandidate = controlFrames.length;
    for (const [offset, payload] of [voiced, voiced, silence, silence].entries()) {
      telnyx.send(JSON.stringify({
        event: "media",
        stream_id: "stream-synthetic-1",
        media: { track: "inbound", chunk: String(offset + 5), payload },
      }));
    }
    const emptyTranscriptFrame = await eventually(
      () => controlFrames.slice(beforeEmptyCandidate).find((frame) =>
        frame.type === "CALLER_EVENT" && frame.event.type === "CALLER_TRANSCRIPT_COMPLETED"),
      "Empty caller transcript was not surfaced for neutral ignore resolution",
    );
    assert.equal(emptyTranscriptFrame.event.transcript, "");
    await eventually(
      () => diagnostics.find((entry) => entry.stage === "EMPTY_CALLER_TURN_AUTO_IGNORED"),
      "Empty caller transcript was not auto-resolved as neutral input",
    );
    assert.equal(runtime.activeSessions(), 1);
    assert.equal(diagnostics.some((entry) => entry.stage === "STT_EMPTY_TRANSCRIPT"), true);
    assert.equal(diagnostics.some((entry) => entry.stage === "STT_FAILED"), false);
    assert.equal(diagnostics.some((entry) => entry.stage === "MEDIA_SESSION_CLOSING"), false);

    await registry.command(claims, {
      type: "CALLER_TURN_DECISION",
      itemId: emptyTranscriptFrame.event.itemId,
      decision: "IGNORE",
      responseId: null,
    });
    assert.equal(runtime.activeSessions(), 1);

    const beforeSecondEmptyCandidate = controlFrames.length;
    for (const [offset, payload] of [voiced, voiced, silence, silence].entries()) {
      telnyx.send(JSON.stringify({
        event: "media",
        stream_id: "stream-synthetic-1",
        media: { track: "inbound", chunk: String(offset + 9), payload },
      }));
    }
    const secondEmptyTranscriptFrame = await eventually(
      () => controlFrames.slice(beforeSecondEmptyCandidate).find((frame) =>
        frame.type === "CALLER_EVENT" && frame.event.type === "CALLER_TRANSCRIPT_COMPLETED"),
      "Input did not recover after an auto-ignored empty caller turn",
    );
    assert.equal(secondEmptyTranscriptFrame.event.itemId, "gemini-candidate-3");
    assert.equal(secondEmptyTranscriptFrame.event.transcript, "");
    assert.equal(runtime.activeSessions(), 1);

    await registry.command(claims, {
      type: "GOVERNED_SPEECH",
      responseId: "handoff-response-synthetic-1",
      text: "Te transfiero ahora.",
      kind: "HANDOFF",
      purpose: "human_handoff_announcement_v37",
    });
    trace.push({ stage: "GOVERNED_EXACT_TEXT_SYNTHESIZED", responseId: "handoff-response-synthetic-1" });
    const governedMedia = await eventually(
      () => telnyxFrames.find((frame) => frame.event === "media" && Buffer.from(frame.media.payload, "base64").length === 4),
      "Governed little-endian PCM did not reach Telnyx playback",
    );
    assert.deepEqual([...Buffer.from(governedMedia.media.payload, "base64")], [0x01, 0x02, 0x03, 0x04]);
    const governedMark = await eventually(
      () => telnyxFrames.filter((frame) => frame.event === "mark").find((frame) =>
        frame.mark.name !== normalMark.mark.name && frame.mark.name !== deterministicMark.mark.name),
      "Governed playback drain mark was not emitted",
    );
    telnyx.send(JSON.stringify({ event: "mark", stream_id: "stream-synthetic-1", mark: governedMark.mark }));
    await eventually(
      () => controlFrames.find((frame) => frame.type === "GOVERNED_EVENT" && frame.event.type === "ASSISTANT_RESPONSE_COMPLETED"),
      "Governed playback completion was not correlated",
    );

    telnyx.send(JSON.stringify({ event: "stop", stream_id: "stream-synthetic-1" }));
    await eventually(() => runtime.activeSessions() === 0, "Media session did not close");
    controlAttachment.detach();
    trace.push({ stage: "SESSION_CLEANED", tenantId: claims.tenantId, callControlId: claims.callControlId });

    assert.equal(credentialConsumptions, 1);
    assert.equal(bootstrapConsumptions, 1);
    assert.equal(registry.size(), 0);
    assert.equal(registry.isActive({ ...claims, callControlId: "other-call" }), false);
    assert.equal(geminiSockets.flatMap((socket) => socket.sent).filter((message) => "clientContent" in message).length, 1);
    assert.equal(trace.some((entry) => entry.stage === "SIDEBAND_AND_MEDIA_ATTACHED"), true);
    assert.equal(trace.some((entry) => entry.stage === "TOOL_RESULT_DELIVERED"), true);
    assert.deepEqual(
      trace.filter((entry) => entry.responseId === "handoff-response-synthetic-1").map((entry) => entry.stage),
      [
        "ASSISTANT_RESPONSE_STARTED",
        "ASSISTANT_AUDIO_STARTED",
        "GOVERNED_EXACT_TEXT_SYNTHESIZED",
        "ASSISTANT_AUDIO_STOPPED",
        "ASSISTANT_RESPONSE_COMPLETED",
      ],
    );
    assert.equal(trace.at(-1).stage, "SESSION_CLEANED");
  } finally {
    try { telnyx.close(); } catch {}
    if (registry.size()) controlAttachment.detach();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
