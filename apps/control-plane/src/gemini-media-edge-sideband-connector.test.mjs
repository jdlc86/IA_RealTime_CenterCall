import assert from "node:assert/strict";
import test from "node:test";
import {
  connectGeminiMediaEdgeSideband,
  geminiMediaEdgeControlUrl,
} from "../.test-dist/gemini-media-edge-sideband-connector.js";

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

test("connector authenticates in header and feeds sanitized Gemini evidence into the owner", async () => {
  const socket = new FakeSocket();
  const requests = [];
  const observations = [];
  const connection = await connectGeminiMediaEdgeSideband(
    input,
    (observation) => observations.push(observation),
    async (url, init) => {
      requests.push({ url, init });
      return { status: 101, webSocket: socket };
    },
  );
  assert.equal(socket.accepted, true);
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${input.controlPlaneToken}`);
  assert.equal(requests[0].init.headers.Upgrade, "websocket");
  assert.equal(requests[0].url.includes(input.controlPlaneToken), false);

  socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { setupComplete: {} } }));
  assert.equal(observations.at(-1).snapshot.state, "READY");
  socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { toolCall: { functionCalls: [{ id: "fc-1", name: "restaurant_business_info" }] } } }));
  assert.equal(observations.at(-1).snapshot.state, "TOOL_WAIT");

  connection.runtime.commandPort.submitToolResult({ callId: "fc-1", toolName: "restaurant_business_info", output: { ok: true } });
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "TOOL_RESULT", callId: "fc-1", toolName: "restaurant_business_info", output: { ok: true } });
});

test("connector fails closed when upgrade does not return a WebSocket", async () => {
  await assert.rejects(
    connectGeminiMediaEdgeSideband(input, () => {}, async () => ({ status: 403 })),
    /upgrade failed with HTTP 403/,
  );
});
