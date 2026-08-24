import assert from "node:assert/strict";
import test from "node:test";
import {
  connectGeminiMediaEdgeSideband,
  connectGeminiMediaEdgeSidebandToProviderHost,
  geminiMediaEdgeControlUrl,
} from "../.test-dist/gemini-media-edge-sideband-connector.js";
import { callerTurnDispositionPortFor } from "../.test-dist/caller-turn-disposition-runtime.js";
import { externalRealtimeProviderCommandPortFor } from "../.test-dist/realtime-provider-external-command-runtime.js";
import { semanticToolGatePortFor } from "../.test-dist/semantic-tool-gate-runtime.js";
import { withGovernedSpeechPort } from "../.test-dist/governed-speech-runtime.js";
import { authoritativeTemporalContextPortFor } from "../.test-dist/authoritative-temporal-context-runtime.js";
import {
  installRealtimeProviderEventIngress,
  removeRealtimeProviderEventIngress,
} from "../.test-dist/realtime-provider-event-ingress-runtime.js";

class FakeSocket {
  constructor() { this.readyState = 1; this.sent = []; this.listeners = new Map(); this.accepted = false; this.closed = null; }
  accept() { this.accepted = true; }
  send(value) { this.sent.push(value); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; }
  addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  emit(type, data = undefined) { for (const listener of this.listeners.get(type) ?? []) listener(type === "message" ? { data } : {}); }
}

const input = {
  edgeUrl: "wss://media.example.test/telnyx/gemini",
  tenantId: "tenant-a",
  callControlId: "call-a",
  controlPlaneToken: "control-token-not-in-url",
};

test("control URL carries identity but never the control-plane token", () => {
  const url = geminiMediaEdgeControlUrl(input);
  assert.equal(url, "https://media.example.test/internal/control?tenant_id=tenant-a&call_control_id=call-a");
  assert.equal(url.includes(input.controlPlaneToken), false);
});

test("connector authenticates in header and feeds provider plus edge evidence into one observer", async () => {
  const socket = new FakeSocket(); const requests = []; const observations = [];
  const connection = await connectGeminiMediaEdgeSideband(input, (observation) => observations.push(observation), async (url, init) => {
    requests.push({ url, init }); return { status: 101, webSocket: socket };
  });
  assert.equal(socket.accepted, true);
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${input.controlPlaneToken}`);
  assert.equal(requests[0].url.includes(input.controlPlaneToken), false);
  socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { setupComplete: {} } }));
  socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { serverContent: { modelTurn: {} } } }));
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "PLAYBACK_BINDING", responseId: "gemini-response-1", kind: "NORMAL" });
  socket.emit("message", JSON.stringify({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-1" } }));
  socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: "gemini-response-1" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(observations.at(-1).events, [{ type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1" }]);
  connection.close();
});

test("connector owns caller disposition, commands, semantic gate, governed speech and temporal context for exactly its socket lifetime", async () => {
  const socket = new FakeSocket(); const host = {};
  let fallbackSpeech = 0;
  const fallback = {
    speak() { fallbackSpeech += 1; },
    requestTextDecision() {}, createSemanticResponse() {}, submitToolResult() {}, updateSessionPolicy() {}, setSemanticToolGate() {}, createDefaultResponse() {}, cancelResponse() {}, clearPlayback() {}, clearInput() {}, discardInputItem() {}, suspendInputDetection() {}, beginNonInterruptingListening() {}, restoreInputDetection() {},
  };
  const governed = withGovernedSpeechPort(host, "GEMINI", fallback);
  const fallbackTemporal = authoritativeTemporalContextPortFor(host);
  const connection = await connectGeminiMediaEdgeSideband({ ...input, capabilityHost: host }, () => {}, async () => ({ status: 101, webSocket: socket }));
  const dispositionPort = callerTurnDispositionPortFor(host);
  const commandPort = externalRealtimeProviderCommandPortFor(host, "GEMINI");
  const gatePort = semanticToolGatePortFor(host);
  assert.ok(dispositionPort);
  assert.equal(commandPort, connection.runtime.commandPort);
  assert.equal(gatePort, connection.runtime.semanticToolGatePort);
  const temporal = authoritativeTemporalContextPortFor(host);
  assert.notEqual(temporal, fallbackTemporal);
  temporal.refresh({ baseInstructions: "BASE", now: new Date("2026-08-23T22:01:00Z"), callerTurn: { itemId: "gemini-candidate-1", transcript: "mañana" } });
  assert.equal(temporal.decideReservationDate("2026-08-24").action, "BLOCK_MISMATCH");
  socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { setupComplete: {} } }));
  socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: null } }));
  socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "Hola" } }));
  dispositionPort.resolve({ itemId: "gemini-candidate-1", disposition: "NORMAL" });
  gatePort.arm();
  gatePort.release();
  governed.speak({ requestId: "governed-1", instructions: "Pronuncia el texto", exactText: "Hola" });
  assert.deepEqual(JSON.parse(socket.sent.at(-4)), { type: "CALLER_TURN_DECISION", itemId: "gemini-candidate-1", decision: "NORMAL", responseId: null });
  assert.deepEqual(JSON.parse(socket.sent.at(-3)), { type: "SEMANTIC_GATE_ARM" });
  assert.deepEqual(JSON.parse(socket.sent.at(-2)), { type: "SEMANTIC_GATE_RELEASE" });
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "GOVERNED_SPEECH", responseId: "governed-1", text: "Hola" });
  assert.equal(fallbackSpeech, 0);
  connection.close();
  assert.equal(callerTurnDispositionPortFor(host), null);
  assert.equal(externalRealtimeProviderCommandPortFor(host, "GEMINI"), null);
  assert.equal(authoritativeTemporalContextPortFor(host), fallbackTemporal);
  assert.throws(() => temporal.decideReservationDate("2026-08-25"), /is closed/);
  governed.speak({ instructions: "fallback", exactText: "Después" });
  assert.equal(fallbackSpeech, 1);

  const secondSocket = new FakeSocket();
  const second = await connectGeminiMediaEdgeSideband({ ...input, capabilityHost: host }, () => {}, async () => ({ status: 101, webSocket: secondSocket }));
  assert.equal(semanticToolGatePortFor(host), second.runtime.semanticToolGatePort);
  second.close();
});

test("host-aware connector fails before network effects when event ingress is absent", async () => {
  const host = {};
  let fetchCalls = 0;
  await assert.rejects(
    connectGeminiMediaEdgeSidebandToProviderHost(
      { ...input, capabilityHost: host },
      async () => { fetchCalls += 1; return { status: 101, webSocket: new FakeSocket() }; },
    ),
    /event ingress is not installed/,
  );
  assert.equal(fetchCalls, 0);
});

test("host-aware connector routes one normalized Gemini event through the installed ingress", async () => {
  const socket = new FakeSocket();
  const host = {};
  const received = [];
  const ingress = async (events) => { received.push(...events); };
  installRealtimeProviderEventIngress(host, ingress);
  const connection = await connectGeminiMediaEdgeSidebandToProviderHost(
    { ...input, capabilityHost: host },
    async () => ({ status: 101, webSocket: socket }),
  );
  socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-9", playbackResponseIdAtStart: null } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(received, [{ type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-9" }]);
  connection.close();
  removeRealtimeProviderEventIngress(host, ingress);
});

test("connector serializes whole observations and drops queued delivery after close", async () => {
  const socket = new FakeSocket();
  const received = [];
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const connection = await connectGeminiMediaEdgeSideband(input, async (observation) => {
    received.push(observation.events[0]?.type);
    if (received.length === 1) await firstPending;
  }, async () => ({ status: 101, webSocket: socket }));

  socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: {
    type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-serial", playbackResponseIdAtStart: null,
  } }));
  socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: {
    type: "CALLER_SPEECH_STOPPED", itemId: "gemini-candidate-serial",
  } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(received, ["CALLER_SPEECH_STARTED"]);

  connection.close();
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(received, ["CALLER_SPEECH_STARTED"]);
});

test("connector fails closed when upgrade does not return a WebSocket", async () => {
  await assert.rejects(connectGeminiMediaEdgeSideband(input, () => {}, async () => ({ status: 403 })), /upgrade failed with HTTP 403/);
});
