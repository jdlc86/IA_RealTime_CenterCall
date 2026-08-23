import assert from "node:assert/strict";
import test from "node:test";
import {
  connectGeminiMediaEdgeSideband,
  geminiMediaEdgeControlUrl,
} from "../.test-dist/gemini-media-edge-sideband-connector.js";
import { callerTurnDispositionPortFor } from "../.test-dist/caller-turn-disposition-runtime.js";

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

test("connector owns neutral caller disposition capability for exactly its socket lifetime", async () => {
  const socket = new FakeSocket(); const host = {};
  const connection = await connectGeminiMediaEdgeSideband({ ...input, capabilityHost: host }, () => {}, async () => ({ status: 101, webSocket: socket }));
  const port = callerTurnDispositionPortFor(host);
  assert.ok(port);
  socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { setupComplete: {} } }));
  socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: { type: "CALLER_SPEECH_STARTED", itemId: "gemini-candidate-1", playbackResponseIdAtStart: null } }));
  socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: { type: "CALLER_TRANSCRIPT_COMPLETED", itemId: "gemini-candidate-1", transcript: "Hola" } }));
  port.resolve({ itemId: "gemini-candidate-1", disposition: "NORMAL" });
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "CALLER_TURN_DECISION", itemId: "gemini-candidate-1", decision: "NORMAL", responseId: null });
  connection.close();
  assert.equal(callerTurnDispositionPortFor(host), null);
});

test("connector fails closed when upgrade does not return a WebSocket", async () => {
  await assert.rejects(connectGeminiMediaEdgeSideband(input, () => {}, async () => ({ status: 403 })), /upgrade failed with HTTP 403/);
});
