import assert from "node:assert/strict";
import test from "node:test";
import { runFastGeminiLiveProbe } from "./fast-live-probe.mjs";

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.closed = null;
  }
  on(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    return this;
  }
  emit(type, value) { for (const listener of this.listeners.get(type) ?? []) listener(value); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code, reason) { this.closed = { code, reason }; }
  open() { this.emit("open"); }
  message(value) { this.emit("message", JSON.stringify(value)); }
}

test("fast live probe proves setup plus native audio turn without exposing provider content", async () => {
  let socket;
  const resultPromise = runFastGeminiLiveProbe({
    apiKey: "probe-secret-key",
    timeoutMs: 2_000,
    createSocket(url) {
      assert.equal(url.searchParams.get("key"), "probe-secret-key");
      socket = new FakeSocket();
      return socket;
    },
  });
  socket.open();
  assert.equal(socket.sent[0].setup.model, "models/gemini-3.1-flash-live-preview");
  socket.message({ setupComplete: {} });
  assert.deepEqual(socket.sent[1], { realtimeInput: { text: "Di un saludo muy breve en español." } });
  socket.message({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] },
      turnComplete: true,
    },
  });
  const result = await resultPromise;
  assert.equal(result.status, "ready");
  assert.equal(result.model, "gemini-3.1-flash-live-preview");
  assert.equal(result.audioParts, 1);
  assert.equal(result.turnComplete, true);
  assert.ok(Number.isInteger(result.setupMs));
  assert.ok(Number.isInteger(result.firstAudioMs));
  assert.equal(JSON.stringify(result).includes("AAAA"), false);
  assert.equal(JSON.stringify(result).includes("probe-secret-key"), false);
});

test("fast live probe fails closed if socket closes before provider contract completes", async () => {
  let socket;
  const resultPromise = runFastGeminiLiveProbe({
    apiKey: "probe-secret-key",
    timeoutMs: 2_000,
    createSocket() { socket = new FakeSocket(); return socket; },
  });
  socket.open();
  socket.emit("close", 1006);
  const result = await resultPromise;
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "SOCKET_FAILED");
});
