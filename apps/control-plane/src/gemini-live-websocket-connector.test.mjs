import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeminiLiveWebSocketUrl,
  connectGeminiLiveWebSocket,
  DEFAULT_GEMINI_LIVE_MODEL,
} from "../.test-dist/gemini-live-websocket-connector.js";

class FakeSocket {
  readyState = 0;
  listeners = new Map();
  addEventListener(name, callback) {
    const values = this.listeners.get(name) ?? [];
    values.push(callback);
    this.listeners.set(name, values);
  }
  removeEventListener(name, callback) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((value) => value !== callback));
  }
  send() {}
  close() {}
  emit(name) {
    for (const callback of this.listeners.get(name) ?? []) callback({ type: name });
  }
}

test("Gemini connector uses current v1beta Live endpoint and default model identity", () => {
  assert.equal(DEFAULT_GEMINI_LIVE_MODEL, "gemini-3.1-flash-live-preview");
  const url = new URL(buildGeminiLiveWebSocketUrl("secret-key"));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.hostname, "generativelanguage.googleapis.com");
  assert.match(url.pathname, /v1beta\.GenerativeService\.BidiGenerateContent$/);
  assert.equal(url.searchParams.get("key"), "secret-key");
});

test("connector resolves only after websocket open", async () => {
  const socket = new FakeSocket();
  let capturedUrl = "";
  const pending = connectGeminiLiveWebSocket("secret-key", (url) => {
    capturedUrl = url;
    return socket;
  });
  let resolved = false;
  void pending.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.ok(capturedUrl.includes("key=secret-key"));
  socket.emit("open");
  assert.equal(await pending, socket);
});

test("connector errors never echo provider credentials", async () => {
  const apiKey = "very-secret-provider-key";
  await assert.rejects(
    connectGeminiLiveWebSocket(apiKey, () => { throw new Error(`failed ${apiKey}`); }),
    (error) => error instanceof Error && !error.message.includes(apiKey) && /construction failed/.test(error.message),
  );

  const socket = new FakeSocket();
  const pending = connectGeminiLiveWebSocket(apiKey, () => socket);
  socket.emit("error");
  await assert.rejects(
    pending,
    (error) => error instanceof Error && !error.message.includes(apiKey) && /connection failed/.test(error.message),
  );
});

test("connector fails closed on empty API key", () => {
  assert.throws(() => buildGeminiLiveWebSocketUrl("   "), /API key is required/);
});
