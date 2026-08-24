import assert from "node:assert/strict";
import test from "node:test";
import { connectGeminiMediaEdgeSidebandToProviderHost } from "../.test-dist/gemini-media-edge-sideband-connector.js";
import {
  installSemanticDecisionPort,
  removeSemanticDecisionPort,
  semanticDecisionPortFor,
} from "../.test-dist/semantic-decision-runtime.js";
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
}

const input = {
  edgeUrl: "wss://media.example.test/telnyx/gemini",
  tenantId: "tenant-a",
  callControlId: "call-a",
  controlPlaneToken: "control-token-not-in-url",
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("Gemini sideband owns isolated semantic decision capability for exactly its lifetime", async () => {
  const socket = new FakeSocket();
  const host = {};
  const received = [];
  const completed = deferred();
  const ingress = async (events) => {
    received.push(...events);
    if (events[0]?.type === "TEXT_DECISION_COMPLETED") completed.resolve();
  };
  installRealtimeProviderEventIngress(host, ingress);

  const requests = [];
  const connection = await connectGeminiMediaEdgeSidebandToProviderHost(
    { ...input, capabilityHost: host },
    async (url, init) => {
      requests.push({ url, init });
      if (url.includes("/internal/control")) return { status: 101, webSocket: socket };
      if (url.includes("/internal/semantic-decision")) {
        return new Response(JSON.stringify({ ok: true, text: "IGNORE_CONFIRMED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  );

  const decisionPort = semanticDecisionPortFor(host);
  decisionPort.request({
    purpose: "barge_in_classifier_rebuild",
    metadata: { source_item_id: "caller-item-11" },
    instructions: "Return exactly one decision label.",
    inputText: "Transcripción: televisión de fondo",
    maxOutputTokens: 8,
  });
  await completed.promise;

  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "https://media.example.test/internal/semantic-decision");
  assert.equal(requests[1].url.includes(input.controlPlaneToken), false);
  assert.equal(requests[1].init.headers.Authorization, `Bearer ${input.controlPlaneToken}`);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    tenantId: "tenant-a",
    callControlId: "call-a",
    instructions: "Return exactly one decision label.",
    inputText: "Transcripción: televisión de fondo",
    maxOutputTokens: 8,
  });
  assert.equal(received.length, 2);
  assert.equal(received[0].type, "ASSISTANT_RESPONSE_STARTED");
  assert.equal(received[0].purpose, "barge_in_classifier_rebuild");
  assert.equal(received[0].sourceItemId, "caller-item-11");
  assert.deepEqual(received[1], {
    type: "TEXT_DECISION_COMPLETED",
    responseId: received[0].responseId,
    text: "IGNORE_CONFIRMED",
  });

  connection.close();
  assert.throws(() => decisionPort.request({ instructions: "x", inputText: "y" }), /closed/);

  const replacement = { request() {} };
  assert.doesNotThrow(() => installSemanticDecisionPort(host, replacement));
  removeSemanticDecisionPort(host, replacement);
  removeRealtimeProviderEventIngress(host, ingress);
});
