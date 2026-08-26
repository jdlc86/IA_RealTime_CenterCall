import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { canonicalEdgeControlBootstrap, controlWebSocketConnectionV1 } from "./edge-control-bootstrap.mjs";

const PROTOCOL = "gemini-control.v1";
const MAX_PENDING = 32;

function positiveSafeInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function messageText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  throw new Error("Gemini control reply frame type is unsupported");
}

function parseReply(raw, callSessionId) {
  let value;
  try { value = JSON.parse(messageText(raw)); }
  catch { throw new Error("Gemini control reply is invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gemini control reply is invalid");
  if (value.protocol !== PROTOCOL || value.call_session_id !== callSessionId) {
    throw new Error("Gemini control reply binding is invalid");
  }
  required(value.message_id, "Gemini control reply message_id");
  const sequence = positiveSafeInteger(value.sequence, "Gemini control reply sequence");
  if (value.type !== "ACK" && value.type !== "NACK") throw new Error("Gemini control reply type is unsupported by v1 client");
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) {
    throw new Error("Gemini control reply payload is invalid");
  }
  const correlatedMessageId = value.type === "ACK"
    ? required(value.payload.acked_message_id, "Gemini control ACK message id")
    : required(value.payload.rejected_message_id, "Gemini control NACK message id");
  return Object.freeze({ value, sequence, correlatedMessageId });
}

function defaultSocketFactory(url, options) {
  return new WebSocket(url, options);
}

export class GeminiEdgeControlClientV1 {
  constructor(bootstrapValue, { socketFactory = defaultSocketFactory, nowEpochMs = Date.now() } = {}) {
    this.bootstrap = canonicalEdgeControlBootstrap(bootstrapValue, nowEpochMs);
    this.socketFactory = socketFactory;
    this.socket = null;
    this.nextLocalSequence = 1;
    this.lastWorkerSequenceApplied = 0;
    this.pending = new Map();
    this.connected = false;
  }

  connect() {
    if (this.socket) throw new Error("Gemini edge control socket already exists");
    const connection = controlWebSocketConnectionV1(this.bootstrap);
    const socket = this.socketFactory(connection.url, connection.options);
    this.socket = socket;

    return new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanupOpen();
        this.connected = true;
        socket.addEventListener("message", (event) => this.#onMessage(event.data));
        socket.addEventListener("close", () => { this.connected = false; });
        resolve();
      };
      const onError = () => {
        cleanupOpen();
        reject(new Error("Gemini edge control WebSocket connection failed"));
      };
      const cleanupOpen = () => {
        socket.removeEventListener?.("open", onOpen);
        socket.removeEventListener?.("error", onError);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
  }

  async sendEdgeReady(providerConnectionEpoch) {
    return this.#send("EDGE_READY", {
      edge_session_id: this.bootstrap.edgeSessionId,
      provider_connection_epoch: positiveSafeInteger(providerConnectionEpoch, "providerConnectionEpoch"),
    });
  }

  snapshot() {
    return Object.freeze({
      callSessionId: this.bootstrap.callSessionId,
      edgeSessionId: this.bootstrap.edgeSessionId,
      nextLocalSequence: this.nextLocalSequence,
      lastWorkerSequenceApplied: this.lastWorkerSequenceApplied,
      pendingCount: this.pending.size,
      connected: this.connected,
    });
  }

  close(code = 1000, reason = "edge control close") {
    this.socket?.close(code, reason);
    this.socket = null;
    this.connected = false;
  }

  #send(type, payload) {
    if (!this.socket || !this.connected || this.socket.readyState !== 1) {
      throw new Error("Gemini edge control WebSocket is not open");
    }
    if (this.pending.size >= MAX_PENDING) throw new Error("Gemini edge control pending window is full");
    const messageId = randomUUID();
    const sequence = this.nextLocalSequence++;
    const envelope = Object.freeze({
      protocol: PROTOCOL,
      call_session_id: this.bootstrap.callSessionId,
      message_id: messageId,
      sequence,
      type,
      ack_required: true,
      payload: Object.freeze({ ...payload }),
    });

    return new Promise((resolve, reject) => {
      this.pending.set(messageId, { resolve, reject, sequence, envelope });
      try { this.socket.send(JSON.stringify(envelope)); }
      catch (error) {
        this.pending.delete(messageId);
        reject(error);
      }
    });
  }

  #onMessage(data) {
    let reply;
    try { reply = parseReply(data, this.bootstrap.callSessionId); }
    catch (error) {
      this.#failAll(error);
      this.socket?.close(1008, "invalid control reply");
      return;
    }

    const expected = this.lastWorkerSequenceApplied + 1;
    if (reply.sequence !== expected) {
      this.#failAll(new Error(`Gemini control reply sequence gap: expected ${expected}, received ${reply.sequence}`));
      this.socket?.close(1008, "control reply sequence gap");
      return;
    }
    this.lastWorkerSequenceApplied = reply.sequence;

    const pending = this.pending.get(reply.correlatedMessageId);
    if (!pending) {
      this.#failAll(new Error("Gemini control reply correlation is unknown"));
      this.socket?.close(1008, "unknown control reply correlation");
      return;
    }
    this.pending.delete(reply.correlatedMessageId);

    if (reply.value.type === "NACK") {
      const error = new Error(`Gemini control command rejected: ${String(reply.value.payload.code ?? "NACK")}`);
      Object.assign(error, { controlReply: reply.value });
      pending.reject(error);
      return;
    }
    pending.resolve(reply.value);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
