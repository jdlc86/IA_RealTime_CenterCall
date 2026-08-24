import assert from "node:assert/strict";
import test from "node:test";
import { connectGeminiMediaEdgeSideband } from "../.test-dist/gemini-media-edge-sideband-connector.js";
import { isolatedTextGenerationPortFor } from "../.test-dist/isolated-text-generation-runtime.js";

class FakeSocket {
  constructor() { this.readyState = 1; this.listeners = new Map(); }
  accept() {}
  send() {}
  close() { this.readyState = 3; }
  addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
}

const input = {
  edgeUrl: "wss://media.example.test/telnyx/gemini",
  tenantId: "tenant-a",
  callControlId: "call-a",
  controlPlaneToken: "control-token-not-in-url",
};

test("Gemini sideband owns isolated generation for exactly its lifetime", async () => {
  const host = {};
  assert.throws(() => isolatedTextGenerationPortFor(host), /not installed/);

  const first = await connectGeminiMediaEdgeSideband(
    { ...input, capabilityHost: host },
    () => {},
    async () => ({ status: 101, webSocket: new FakeSocket() }),
  );
  assert.ok(isolatedTextGenerationPortFor(host));

  first.close();
  assert.throws(() => isolatedTextGenerationPortFor(host), /not installed/);

  const second = await connectGeminiMediaEdgeSideband(
    { ...input, capabilityHost: host },
    () => {},
    async () => ({ status: 101, webSocket: new FakeSocket() }),
  );
  assert.ok(isolatedTextGenerationPortFor(host));
  second.close();
  assert.throws(() => isolatedTextGenerationPortFor(host), /not installed/);
});
