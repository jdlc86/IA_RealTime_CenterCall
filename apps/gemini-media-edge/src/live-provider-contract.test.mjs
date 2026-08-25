import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { runGeminiLiveProviderContractProbe } from "./live-provider-contract.mjs";

class FakeSocket extends EventEmitter {
  constructor(mode) {
    super();
    this.mode = mode;
    this.sent = [];
    this.terminated = false;
    setImmediate(() => this.emit("open"));
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.setup) {
      setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({ setupComplete: {} }))));
      return;
    }
    if (!message?.realtimeInput?.text) return;
    if (this.mode === "tool") {
      setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({
        serverContent: { modelTurn: { parts: [{ thought: true, text: "internal", thoughtSignature: "sig" }] } },
      }))));
      setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({
        toolCall: { functionCalls: [{ id: "provider-call-1", name: "restaurant_reservation_create", args: {} }] },
      }))));
    } else if (this.mode === "direct") {
      setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({
        serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AA==" } }] } },
      }))));
    } else if (this.mode === "missing-id") {
      setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({
        toolCall: { functionCalls: [{ name: "restaurant_reservation_create", args: {} }] },
      }))));
    } else if (this.mode === "mismatch") {
      setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({
        toolCall: { functionCalls: [{ id: "provider-call-2", name: "restaurant_conversation", args: {} }] },
      }))));
    }
  }

  terminate() { this.terminated = true; }
}

function create(mode, captured) {
  return (url) => {
    captured.url = String(url);
    captured.socket = new FakeSocket(mode);
    return captured.socket;
  };
}

test("live provider contract accepts only a real correlated reservation function call", async () => {
  const captured = {};
  const result = await runGeminiLiveProviderContractProbe({
    apiKey: "unit-secret-key",
    model: "gemini-3.1-flash-live-preview",
    timeoutMs: 1_000,
    createSocket: create("tool", captured),
  });
  assert.deepEqual(result, { status: "ready", expectedTool: "restaurant_reservation_create" });
  assert.equal(captured.socket.terminated, true);
  assert.equal(captured.socket.sent[0].setup.tools[0].functionDeclarations[0].behavior, "BLOCKING");
  assert.equal(captured.socket.sent[0].setup.tools[0].functionDeclarations[0].description.includes("progressive multi-turn operation"), true);
  assert.deepEqual(captured.socket.sent[1], { realtimeInput: { text: "Quiero hacer una reserva." } });
  assert.equal(JSON.stringify(result).includes("unit-secret-key"), false);
});

test("live provider contract rejects direct model output before the governed tool call", async () => {
  const result = await runGeminiLiveProviderContractProbe({
    apiKey: "unit-secret-key",
    timeoutMs: 1_000,
    createSocket: create("direct", {}),
  });
  assert.deepEqual(result, { status: "failed", failureCategory: "DIRECT_OUTPUT_BEFORE_TOOL_CALL" });
});

test("live provider contract requires the real provider call id and expected tool identity", async () => {
  const missingId = await runGeminiLiveProviderContractProbe({
    apiKey: "unit-secret-key",
    timeoutMs: 1_000,
    createSocket: create("missing-id", {}),
  });
  assert.deepEqual(missingId, { status: "failed", failureCategory: "MISSING_PROVIDER_CALL_ID" });

  const mismatch = await runGeminiLiveProviderContractProbe({
    apiKey: "unit-secret-key",
    timeoutMs: 1_000,
    createSocket: create("mismatch", {}),
  });
  assert.deepEqual(mismatch, { status: "failed", failureCategory: "TOOL_MISMATCH", observedTool: "restaurant_conversation" });
});

test("live provider contract fails closed without configuration and never returns raw provider content", async () => {
  assert.deepEqual(await runGeminiLiveProviderContractProbe({}), { status: "failed", failureCategory: "CONFIGURATION" });
});
