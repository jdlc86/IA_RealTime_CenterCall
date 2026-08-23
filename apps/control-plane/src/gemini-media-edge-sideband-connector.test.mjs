import assert from "node:assert/strict";
import test from "node:test";
import {
  connectGeminiMediaEdgeSideband,
  connectGeminiMediaEdgeSidebandToProviderHost,
  geminiMediaEdgeControlUrl,
} from "../.test-dist/gemini-media-edge-sideband-connector.js";
import { callerTurnDispositionPortFor } from "../.test-dist/caller-turn-disposition-runtime.js";
import { externalRealtimeProviderCommandPortFor } from "../.test-dist/realtime-provider-external-command-runtime.js";
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
  assert.deepEqual(observations.at(-1).events, [{ type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1" }]);
  connection.close();
});

test("connector owns neutral caller disposition and provider command capabilities for exactly its socket lifetime", async () => {
  const socket = new FakeSocket(); const host = {};
  const connection = await connectGeminiMediaEdgeSideband({ ...input, capabilityHost: host }, () => {}, async () => ({ status: 101, webSocket: socket }));
  const dispositionPort = callerTurnDispositionPortFor(host);
  const commandPort = externalRealtimeProviderCommandPortFor(host, "GEMINI");
  assert.ok(dispositionPort);
  assert.equal(commandPort, connection.runtime.commandPort);
  socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { setupComplete: {} } }));
  socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: null } }));
  socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "Hola" } }));
  dispositionPort.resolve({ itemId: "gemini-candidate-1", disposition: "NORMAL" });
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "CALLER_TURN_DECISION", itemId: "gemini-candidate-1", decision: "NORMAL", responseId: null });
  connection.close();
  assert.equal(callerTurnDispositionPortFor(host), null);
  assert.equal(externalRealtimeProviderCommandPortFor(host, "GEMINI"), null);
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

test("connector fails closed when upgrade does not return a WebSocket", async () => {
  await assert.rejects(connectGeminiMediaEdgeSideband(input, () => {}, async () => ({ status: 403 })), /upgrade failed with HTTP 403/);
});
