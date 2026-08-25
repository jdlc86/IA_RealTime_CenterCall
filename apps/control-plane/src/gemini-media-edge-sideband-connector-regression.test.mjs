import assert from "node:assert/strict";
import test from "node:test";
import {
  connectGeminiMediaEdgeSideband,
  connectGeminiMediaEdgeSidebandToProviderHost,
} from "../.test-dist/gemini-media-edge-sideband-connector.js";
import { classifyGeminiSidebandClose } from "../.test-dist/realtime-provider-call-session-composition.js";
import {
  installRealtimeProviderEventIngress,
  removeRealtimeProviderEventIngress,
} from "../.test-dist/realtime-provider-event-ingress-runtime.js";

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.listeners = new Map();
    this.accepted = false;
    this.closed = null;
  }
  accept() { this.accepted = true; }
  send(value) { this.sent.push(value); }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, data = undefined) {
    const event = type === "message" ? { data } : (data ?? {});
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const input = {
  edgeUrl: "wss://media.example.test/telnyx/gemini",
  tenantId: "tenant-regression",
  callControlId: "call-regression",
  controlPlaneToken: "control-token-not-in-url",
};

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("real connector keeps sideband open across reset, governed playback, listening restore and completion", async () => {
  const socket = new FakeSocket();
  const host = {};
  const received = [];
  let connection;
  const ingress = async (events) => {
    for (const event of events) {
      received.push(event);
      if (event.type === "ASSISTANT_AUDIO_STARTED") {
        connection.runtime.commandPort.beginNonInterruptingListening();
      } else if (event.type === "ASSISTANT_AUDIO_STOPPED") {
        connection.runtime.commandPort.restoreInputDetection();
      }
    }
  };
  installRealtimeProviderEventIngress(host, ingress);

  connection = await connectGeminiMediaEdgeSidebandToProviderHost(
    { ...input, capabilityHost: host },
    async () => ({ status: 101, webSocket: socket }),
  );
  assert.equal(socket.accepted, true);

  socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { setupComplete: {} } }));
  socket.emit("message", JSON.stringify({
    type: "GEMINI_EVENT",
    message: { toolCall: { functionCalls: [{
      id: "reservation-tool-regression-1",
      name: "restaurant_reservation_create",
      args: {},
    }] } },
  }));
  await flush();

  const oldResponseId = connection.runtime.snapshot().activeResponseId;
  assert.ok(oldResponseId);
  connection.runtime.commandPort.bypassDeterministicToolContinuation(
    {
      callId: "reservation-tool-regression-1",
      toolName: "restaurant_reservation_create",
      output: { ok: false, status: "MISSING_INFORMATION", missing: ["starts_at", "party_size"] },
    },
    "RESERVATION_PARTY_SIZE",
  );
  assert.equal(JSON.parse(socket.sent.at(-1)).type, "DETERMINISTIC_TOOL_BYPASS");

  socket.emit("message", JSON.stringify({
    type: "PROVIDER_SESSION_RESET",
    event: {
      callId: "reservation-tool-regression-1",
      responseId: oldResponseId,
      continuationContext: "RESERVATION_PARTY_SIZE",
    },
  }));
  await flush();
  assert.equal(received.some((event) => event.type === "ASSISTANT_RESPONSE_COMPLETED"
    && event.responseId === oldResponseId
    && event.status === "interrupted"), true);

  const governedResponseId = "governed-deterministic-response-connector-1";
  connection.runtime.governedSpeechPort.speak({
    requestId: governedResponseId,
    instructions: "Pronuncia exactamente la pregunta de continuación.",
    exactText: "Indica fecha, hora y número de personas.",
    purpose: "gemini_deterministic_reservation_state_v56",
  });
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), {
    type: "GOVERNED_SPEECH",
    responseId: governedResponseId,
    text: "Indica fecha, hora y número de personas.",
    purpose: "gemini_deterministic_reservation_state_v56",
  });

  socket.emit("message", JSON.stringify({
    type: "GOVERNED_EVENT",
    event: {
      type: "ASSISTANT_RESPONSE_STARTED",
      responseId: governedResponseId,
      kind: "NORMAL",
      purpose: "gemini_deterministic_reservation_state_v56",
    },
  }));
  socket.emit("message", JSON.stringify({
    type: "PLAYBACK_EVENT",
    event: { type: "ASSISTANT_AUDIO_STARTED", responseId: governedResponseId, kind: "NORMAL" },
  }));
  await flush();
  assert.equal(socket.sent.map((value) => JSON.parse(value)).some((message) => message.type === "INPUT_DETECTION_RESTORE"), true);
  assert.equal(socket.closed, null);

  socket.emit("message", JSON.stringify({
    type: "INPUT_DETECTION_EVENT",
    event: {
      type: "INPUT_DETECTION_UPDATED",
      present: true,
      settings: { createResponse: false, interruptResponse: false },
    },
  }));
  socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { setupComplete: {} } }));
  socket.emit("message", JSON.stringify({
    type: "PLAYBACK_EVENT",
    event: { type: "ASSISTANT_AUDIO_STOPPED", responseId: governedResponseId, kind: "NORMAL" },
  }));
  socket.emit("message", JSON.stringify({
    type: "GOVERNED_EVENT",
    event: {
      type: "ASSISTANT_RESPONSE_COMPLETED",
      responseId: governedResponseId,
      kind: "NORMAL",
      status: "completed",
    },
  }));
  await flush();

  assert.equal(socket.closed, null);
  assert.equal(received.some((event) => event.type === "INPUT_DETECTION_UPDATED"), true);
  assert.equal(received.some((event) => event.type === "ASSISTANT_AUDIO_STOPPED"
    && event.responseId === governedResponseId), true);
  assert.equal(received.some((event) => event.type === "ASSISTANT_RESPONSE_COMPLETED"
    && event.responseId === governedResponseId
    && event.status === "completed"), true);
  assert.equal(socket.sent.map((value) => JSON.parse(value)).filter((message) => message.type === "INPUT_DETECTION_RESTORE").length, 2);

  connection.close();
  removeRealtimeProviderEventIngress(host, ingress);
});

test("connector observation failure reports only safe frame type and stable category", async () => {
  const socket = new FakeSocket();
  const diagnostics = [];
  const connection = await connectGeminiMediaEdgeSideband(
    { ...input, observeDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
    () => {},
    async () => ({ status: 101, webSocket: socket }),
  );

  socket.emit("message", JSON.stringify({
    type: "PROVIDER_SESSION_RESET",
    event: { callId: "stale-call", responseId: "stale-response" },
  }));
  await flush();

  assert.deepEqual(socket.closed, { code: 1008, reason: "invalid sideband event" });
  assert.deepEqual(diagnostics, [{
    stage: "GEMINI_SIDEBAND_OBSERVATION_FAILED",
    frameType: "PROVIDER_SESSION_RESET",
    failureCategory: "PROVIDER_RESET_IDENTITY_MISMATCH",
  }]);
  connection.close();
});

test("Gemini sideband close reasons are reduced to safe stable categories", () => {
  assert.equal(classifyGeminiSidebandClose(1008, "invalid control command"), "MEDIA_EDGE_CONTROL_COMMAND_REJECTED");
  assert.equal(classifyGeminiSidebandClose(1008, "arbitrary remote text"), "POLICY_VIOLATION");
  assert.equal(classifyGeminiSidebandClose(1011, "anything"), "SIDEBAND_INTERNAL_ERROR");
  assert.equal(classifyGeminiSidebandClose(1000, "control session closed"), "NORMAL_CONTROL_CLOSE");
});
