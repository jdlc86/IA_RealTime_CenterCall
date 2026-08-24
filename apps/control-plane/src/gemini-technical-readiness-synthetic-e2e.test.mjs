import assert from "node:assert/strict";
import test from "node:test";
import { authoritativeTemporalContextPortFor } from "../.test-dist/authoritative-temporal-context-runtime.js";
import { withAuthoritativeTemporalToolResult } from "../.test-dist/authoritative-temporal-tool-result.js";
import { callerTurnDispositionPortFor } from "../.test-dist/caller-turn-disposition-runtime.js";
import { connectGeminiMediaEdgeSidebandToProviderHost } from "../.test-dist/gemini-media-edge-sideband-connector.js";
import { withGovernedSpeechPort } from "../.test-dist/governed-speech-runtime.js";
import { requireInboundRealtimeRouteReady, planInboundRealtimeRoute } from "../.test-dist/inbound-realtime-route.js";
import { realtimeProviderCapabilities, requireRealtimeProviderTrafficReadiness } from "../.test-dist/realtime-provider-capabilities.js";
import { externalRealtimeProviderCommandPortFor } from "../.test-dist/realtime-provider-external-command-runtime.js";
import {
  installRealtimeProviderEventIngress,
  removeRealtimeProviderEventIngress,
} from "../.test-dist/realtime-provider-event-ingress-runtime.js";
import { selectRealtimeProvider } from "../.test-dist/realtime-provider-selector.js";
import { semanticToolGatePortFor } from "../.test-dist/semantic-tool-gate-runtime.js";

class FakeSocket {
  constructor() { this.readyState = 1; this.sent = []; this.listeners = new Map(); this.accepted = false; }
  accept() { this.accepted = true; }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, data = undefined) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(type === "message" ? { data } : {});
    }
  }
}

function tenant() {
  return {
    schemaVersion: 1,
    tenantId: "tenant-synthetic",
    status: "active",
    business: { displayName: "Restaurante Sintético", facts: {} },
    assistant: { name: "Lucía", greeting: "Hola", language: "es-ES" },
    realtime: { provider: "GEMINI" },
    tools: { allowed: ["restaurant_business_info"] },
  };
}

function fallbackCommandPort(onSpeak) {
  return {
    speak: onSpeak,
    requestTextDecision() {}, createSemanticResponse() {}, submitToolResult() {},
    updateSessionPolicy() {}, setSemanticToolGate() {}, createDefaultResponse() {},
    cancelResponse() {}, clearPlayback() {}, clearInput() {}, discardInputItem() {},
    suspendInputDetection() {}, beginNonInterruptingListening() {}, restoreInputDetection() {},
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("disabled Gemini technical rehearsal preserves one identity trace from selection through cleanup", async () => {
  const trace = [];
  const selection = await selectRealtimeProvider(tenant(), null);
  const route = planInboundRealtimeRoute(selection);
  trace.push({ stage: "PROVIDER_SELECTED", tenantId: selection.tenantId, provider: selection.provider, transport: route.transport });
  assert.equal(requireRealtimeProviderTrafficReadiness("GEMINI"), realtimeProviderCapabilities("GEMINI"));
  assert.throws(() => requireInboundRealtimeRouteReady(selection), /registered but not enabled for traffic: GEMINI/);
  trace.push({ stage: "PRODUCTION_ADMISSION_BLOCKED", provider: selection.provider });

  const socket = new FakeSocket();
  const host = {};
  const requests = [];
  const callerNow = new Date("2026-08-23T22:01:00Z");
  const resultNow = new Date("2026-08-23T22:01:02Z");
  let ingressTail = Promise.resolve();
  let fallbackSpeech = 0;
  let callerItemId = null;
  const governed = withGovernedSpeechPort(host, "GEMINI", fallbackCommandPort(() => { fallbackSpeech += 1; }));

  const handleEvent = async (event) => {
    if (event.type === "CALLER_SPEECH_STARTED") {
      callerItemId = event.itemId;
      trace.push({ stage: "CALLER_ITEM_STARTED", itemId: event.itemId });
      return;
    }
    if (event.type === "CALLER_TRANSCRIPT_COMPLETED") {
      assert.equal(event.itemId, callerItemId);
      authoritativeTemporalContextPortFor(host).refresh({
        baseInstructions: "CANONICAL_POLICY",
        now: callerNow,
        callerTurn: { itemId: event.itemId, transcript: event.transcript },
      });
      callerTurnDispositionPortFor(host).resolve({ itemId: event.itemId, disposition: "NORMAL" });
      externalRealtimeProviderCommandPortFor(host, "GEMINI").createDefaultResponse();
      semanticToolGatePortFor(host).arm();
      trace.push({ stage: "CALLER_ITEM_COMMITTED", itemId: event.itemId, disposition: "NORMAL" });
      trace.push({ stage: "SEMANTIC_GATE_ARMED", itemId: event.itemId });
      return;
    }
    if (event.type === "SEMANTIC_TOOL_SELECTED") {
      trace.push({ stage: "TOOL_SELECTED", itemId: callerItemId, callId: event.callId, toolName: event.name });
      semanticToolGatePortFor(host).release();
      const gemini = externalRealtimeProviderCommandPortFor(host, "GEMINI");
      assert.ok(gemini);
      gemini.submitToolResult(withAuthoritativeTemporalToolResult({
        callId: event.callId,
        toolName: event.name,
        output: { ok: true, status: "BUSINESS_INFO_READY" },
      }, resultNow));
      gemini.createDefaultResponse();
      trace.push({ stage: "TOOL_RESULT_DELIVERED", callId: event.callId, toolName: event.name });
      return;
    }
    if (event.type === "ASSISTANT_RESPONSE_STARTED") {
      trace.push({ stage: "RESPONSE_STARTED", responseId: event.responseId, kind: event.kind });
      return;
    }
    if (event.type === "ASSISTANT_AUDIO_STARTED") {
      trace.push({ stage: "PLAYBACK_STARTED", responseId: event.responseId, kind: event.kind });
      return;
    }
    if (event.type === "ASSISTANT_RESPONSE_COMPLETED") {
      trace.push({ stage: "RESPONSE_COMPLETED", responseId: event.responseId, kind: event.kind });
      return;
    }
    if (event.type === "ASSISTANT_AUDIO_STOPPED") {
      trace.push({ stage: "PLAYBACK_STOPPED", responseId: event.responseId, kind: event.kind });
    }
  };
  const ingress = (events) => {
    ingressTail = ingressTail.then(async () => {
      for (const event of events) await handleEvent(event);
    });
    return ingressTail;
  };
  installRealtimeProviderEventIngress(host, ingress);

  const connection = await connectGeminiMediaEdgeSidebandToProviderHost({
    edgeUrl: "wss://media.example.test/telnyx/gemini",
    tenantId: selection.tenantId,
    callControlId: "call-synthetic",
    controlPlaneToken: "synthetic-control-token-not-for-logs",
    capabilityHost: host,
  }, async (url, init) => {
    requests.push({ url, init });
    return { status: 101, webSocket: socket };
  });
  trace.push({ stage: "SIDEBAND_ATTACHED", tenantId: selection.tenantId, callControlId: "call-synthetic" });

  try {
    socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { setupComplete: {} } }));
    socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: {
      type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: null,
    } }));
    socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: {
      type: "CALLER_SPEECH_STOPPED", itemId: "gemini-candidate-1",
    } }));
    socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: {
      type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "¿A qué hora abren mañana?",
    } }));
    await settle();
    await ingressTail;

    socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { toolCall: { functionCalls: [{
      id: "business-info-1", name: "restaurant_business_info", args: { topics: ["HOURS"] },
    }] } } }));
    await settle();
    await ingressTail;

    socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: {
      serverContent: { modelTurn: {}, outputTranscription: { text: "Abrimos a las nueve." } },
    } }));
    socket.emit("message", JSON.stringify({ type: "PLAYBACK_EVENT", event: {
      type: "ASSISTANT_AUDIO_STARTED", responseId: "gemini-response-1", kind: "NORMAL",
    } }));
    socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: {
      serverContent: { turnComplete: true },
    } }));
    socket.emit("message", JSON.stringify({ type: "PLAYBACK_EVENT", event: {
      type: "ASSISTANT_AUDIO_STOPPED", responseId: "gemini-response-1", kind: "NORMAL",
    } }));
    await settle();
    await ingressTail;

    governed.speak({
      requestId: "handoff-response-1",
      instructions: "Pronuncia exactamente el anuncio autorizado.",
      exactText: "Te transfiero ahora.",
      purpose: "human_handoff_announcement_v37",
      metadata: { human_handoff_v37: "ANNOUNCEMENT" },
    });
    trace.push({ stage: "GOVERNED_SPEECH_REQUESTED", responseId: "handoff-response-1", kind: "HANDOFF" });
    socket.emit("message", JSON.stringify({ type: "GOVERNED_EVENT", event: {
      type: "ASSISTANT_RESPONSE_STARTED", responseId: "handoff-response-1", kind: "HANDOFF",
      purpose: "human_handoff_announcement_v37",
    } }));
    socket.emit("message", JSON.stringify({ type: "PLAYBACK_EVENT", event: {
      type: "ASSISTANT_AUDIO_STARTED", responseId: "handoff-response-1", kind: "HANDOFF",
    } }));
    socket.emit("message", JSON.stringify({ type: "PLAYBACK_EVENT", event: {
      type: "ASSISTANT_AUDIO_STOPPED", responseId: "handoff-response-1", kind: "HANDOFF",
    } }));
    socket.emit("message", JSON.stringify({ type: "GOVERNED_EVENT", event: {
      type: "ASSISTANT_RESPONSE_COMPLETED", responseId: "handoff-response-1", kind: "HANDOFF", status: "completed",
    } }));
    await settle();
    await ingressTail;

    const outbound = socket.sent.map((value) => JSON.parse(value));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.includes("synthetic-control-token"), false);
    assert.equal(requests[0].init.headers.Authorization, "Bearer synthetic-control-token-not-for-logs");
    assert.deepEqual(outbound.find((message) => message.type === "CALLER_TURN_DECISION"), {
      type: "CALLER_TURN_DECISION", itemId: "gemini-candidate-1", decision: "NORMAL", responseId: null,
    });
    assert.deepEqual(outbound.find((message) => message.type === "GOVERNED_SPEECH"), {
      type: "GOVERNED_SPEECH", responseId: "handoff-response-1", text: "Te transfiero ahora.",
      kind: "HANDOFF", purpose: "human_handoff_announcement_v37",
    });
    const toolResult = outbound.find((message) => message.type === "TOOL_RESULT");
    assert.equal(toolResult.callId, "business-info-1");
    assert.equal(toolResult.output.authoritative_temporal_context.now_iso, "2026-08-24T00:01:02+02:00");
    assert.equal(outbound.some((message) => "clientContent" in message || "realtimeInput" in message || "setup" in message), false);
    assert.equal(fallbackSpeech, 0);

    assert.deepEqual(trace, [
      { stage: "PROVIDER_SELECTED", tenantId: "tenant-synthetic", provider: "GEMINI", transport: "GEMINI_MEDIA_BRIDGE" },
      { stage: "PRODUCTION_ADMISSION_BLOCKED", provider: "GEMINI" },
      { stage: "SIDEBAND_ATTACHED", tenantId: "tenant-synthetic", callControlId: "call-synthetic" },
      { stage: "CALLER_ITEM_STARTED", itemId: "gemini-candidate-1" },
      { stage: "CALLER_ITEM_COMMITTED", itemId: "gemini-candidate-1", disposition: "NORMAL" },
      { stage: "SEMANTIC_GATE_ARMED", itemId: "gemini-candidate-1" },
      { stage: "RESPONSE_STARTED", responseId: "gemini-response-1", kind: "NORMAL" },
      { stage: "TOOL_SELECTED", itemId: "gemini-candidate-1", callId: "business-info-1", toolName: "restaurant_business_info" },
      { stage: "TOOL_RESULT_DELIVERED", callId: "business-info-1", toolName: "restaurant_business_info" },
      { stage: "PLAYBACK_STARTED", responseId: "gemini-response-1", kind: "NORMAL" },
      { stage: "RESPONSE_COMPLETED", responseId: "gemini-response-1", kind: "NORMAL" },
      { stage: "PLAYBACK_STOPPED", responseId: "gemini-response-1", kind: "NORMAL" },
      { stage: "GOVERNED_SPEECH_REQUESTED", responseId: "handoff-response-1", kind: "HANDOFF" },
      { stage: "RESPONSE_STARTED", responseId: "handoff-response-1", kind: "HANDOFF" },
      { stage: "PLAYBACK_STARTED", responseId: "handoff-response-1", kind: "HANDOFF" },
      { stage: "PLAYBACK_STOPPED", responseId: "handoff-response-1", kind: "HANDOFF" },
      { stage: "RESPONSE_COMPLETED", responseId: "handoff-response-1", kind: "HANDOFF" },
    ]);
  } finally {
    connection.close();
    removeRealtimeProviderEventIngress(host, ingress);
  }

  trace.push({ stage: "SESSION_CLEANED", tenantId: selection.tenantId, callControlId: "call-synthetic" });
  assert.equal(callerTurnDispositionPortFor(host), null);
  assert.equal(externalRealtimeProviderCommandPortFor(host, "GEMINI"), null);
  assert.equal(trace.at(-1).stage, "SESSION_CLEANED");
  governed.speak({ instructions: "fallback", exactText: "Después" });
  assert.equal(fallbackSpeech, 1);
});
