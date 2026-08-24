import assert from "node:assert/strict";
import test from "node:test";
import {
  installIsolatedTextGenerationPort,
  isolatedTextGenerationPortFor,
  removeIsolatedTextGenerationPort,
} from "../.test-dist/isolated-text-generation-runtime.js";

test("isolated text generation port is session-scoped and fail-closed", async () => {
  const hostA = {};
  const hostB = {};
  const portA = Object.freeze({ async generate() { return "A"; } });

  assert.throws(() => isolatedTextGenerationPortFor(hostA), /not installed/);
  installIsolatedTextGenerationPort(hostA, portA);
  assert.equal(await isolatedTextGenerationPortFor(hostA).generate({ instructions: "x", inputText: "y" }), "A");
  assert.throws(() => isolatedTextGenerationPortFor(hostB), /not installed/);
  assert.throws(() => installIsolatedTextGenerationPort(hostA, portA), /already installed/);

  removeIsolatedTextGenerationPort(hostA, portA);
  assert.throws(() => isolatedTextGenerationPortFor(hostA), /not installed/);
});

test("isolated text generation removal enforces exact owner", () => {
  const host = {};
  const owner = Object.freeze({ async generate() { return "owner"; } });
  const stranger = Object.freeze({ async generate() { return "stranger"; } });
  installIsolatedTextGenerationPort(host, owner);
  assert.throws(() => removeIsolatedTextGenerationPort(host, stranger), /ownership mismatch/);
  assert.equal(isolatedTextGenerationPortFor(host), owner);
  removeIsolatedTextGenerationPort(host, owner);
});
