import assert from "node:assert/strict";
import test from "node:test";
import { GeminiEdgeControlClientV1 } from "./edge-control-client.mjs";

const NOW = Date.now();
const bootstrap = Object.freeze({
  version: "gemini-edge-control-bootstrap.v1",
  provider: "GEMINI",
  tenantId: "tenant-client",
  callControlId: "call-control-client",
  callSessionId: "call-session-client",
  edgeSessionId: "edge-session-client",
  credentialId: "credential-client",
  controlUrl: "wss://gemini-control.example.test/internal/control",
  controlCapability: "opaque-client-capability",
  notAfterEpochMs: NOW + 60_000,
});

class FakeSocket {
  constructor(onSend) {
    this.readyState = 0;
    this.onSend = onSend;
    this.listeners = new Map();
    this.closed = null;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((item) => item !== listener));
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(value) { this.onSend?.(value, this); }
  close(code, reason) {
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit("close", { code, reason });
  }
  reply(value) { this.emit("message", { data: JSON.stringify(value) }); }
}

function ackFor(envelope, sequence = 1) {
  return {
    protocol: "gemini-control.v1",
    call_session_id: bootstrap.callSessionId,
    message_id: `ack-${sequence}`,
    sequence,
    type: "ACK",
    ack_required: false,
    payload: {
      acked_message_id: envelope.message_id,
      acked_sequence: envelope.sequence,
      result: "APPLIED",
    },
  };
}

test("edge control client uses Bearer WSS and correlates EDGE_READY ACK", async () => {
  const captured = {};
  const client = new GeminiEdgeControlClientV1(bootstrap, {
    nowEpochMs: NOW,
    socketFactory(url, options) {
      captured.url = url;
      captured.options = options;
      return new FakeSocket((raw, socket) => {
        const envelope = JSON.parse(raw);
        captured.envelope = envelope;
        queueMicrotask(() => socket.reply(ackFor(envelope)));
      });
    },
  });

  await client.connect();
  const reply = await client.sendEdgeReady(1);
  assert.equal(captured.url, bootstrap.controlUrl);
  assert.deepEqual(captured.options.headers, { Authorization: "Bearer opaque-client-capability" });
  assert.equal(captured.envelope.type, "EDGE_READY");
  assert.equal(captured.envelope.sequence, 1);
  assert.equal(captured.envelope.payload.edge_session_id, bootstrap.edgeSessionId);
  assert.equal(reply.type, "ACK");
  assert.deepEqual(client.snapshot(), {
    callSessionId: bootstrap.callSessionId,
    edgeSessionId: bootstrap.edgeSessionId,
    nextLocalSequence: 2,
    lastWorkerSequenceApplied: 1,
    pendingCount: 0,
    connected: true,
  });
  client.close();
});

test("edge control client surfaces NACK without poisoning future transport state", async () => {
  let sent;
  const client = new GeminiEdgeControlClientV1(bootstrap, {
    nowEpochMs: NOW,
    socketFactory() {
      return new FakeSocket((raw, socket) => {
        sent = JSON.parse(raw);
        queueMicrotask(() => socket.reply({
          protocol: "gemini-control.v1",
          call_session_id: bootstrap.callSessionId,
          message_id: "nack-1",
          sequence: 1,
          type: "NACK",
          ack_required: false,
          payload: {
            rejected_message_id: sent.message_id,
            rejected_sequence: sent.sequence,
            code: "INVALID_STATE",
            retryable: false,
            terminal: false,
          },
        }));
      });
    },
  });
  await client.connect();
  await assert.rejects(client.sendEdgeReady(1), /INVALID_STATE/);
  assert.equal(client.snapshot().pendingCount, 0);
  assert.equal(client.snapshot().lastWorkerSequenceApplied, 1);
  client.close();
});

test("edge control client fails closed on worker sequence gap", async () => {
  let socket;
  const client = new GeminiEdgeControlClientV1(bootstrap, {
    nowEpochMs: NOW,
    socketFactory() {
      socket = new FakeSocket((raw, transport) => {
        const envelope = JSON.parse(raw);
        queueMicrotask(() => transport.reply(ackFor(envelope, 2)));
      });
      return socket;
    },
  });
  await client.connect();
  await assert.rejects(client.sendEdgeReady(1), /sequence gap/);
  assert.equal(socket.closed.code, 1008);
});
