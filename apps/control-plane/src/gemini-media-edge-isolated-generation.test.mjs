import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiMediaEdgeIsolatedGenerationCapability } from "../.test-dist/gemini-media-edge-isolated-generation.js";

test("isolated generation client uses authenticated session-scoped media-edge endpoint", async () => {
  const calls = [];
  const capability = createGeminiMediaEdgeIsolatedGenerationCapability({
    edgeUrl: "wss://edge.example.test/media?secret=drop-me",
    tenantId: "tenant-a",
    callControlId: "call-a",
    controlPlaneToken: "control-secret",
  }, async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, text: "¿Quieres que te transfiera?" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const text = await capability.generate({
    instructions: "Redacta una pregunta breve.",
    inputText: "Pregunta si desea transferencia.",
    maxOutputTokens: 64,
  });

  assert.equal(text, "¿Quieres que te transfiera?");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://edge.example.test/internal/isolated-generation");
  assert.equal(calls[0].url.includes("control-secret"), false);
  assert.equal(calls[0].url.includes("drop-me"), false);
  assert.equal(calls[0].init.headers.Authorization, "Bearer control-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    tenantId: "tenant-a",
    callControlId: "call-a",
    instructions: "Redacta una pregunta breve.",
    inputText: "Pregunta si desea transferencia.",
    maxOutputTokens: 64,
  });
});

test("isolated generation client fails closed and rejects work after close", async () => {
  const capability = createGeminiMediaEdgeIsolatedGenerationCapability({
    edgeUrl: "wss://edge.example.test/media",
    tenantId: "tenant-a",
    callControlId: "call-a",
    controlPlaneToken: "control-secret",
  }, async () => new Response(JSON.stringify({ ok: false, error: "inactive_session" }), { status: 409 }));

  await assert.rejects(() => capability.generate({ instructions: "x", inputText: "y" }), /HTTP 409/);
  capability.close();
  await assert.rejects(() => capability.generate({ instructions: "x", inputText: "y" }), /closed/);
});

test("isolated generation client rejects unsafe edge URLs before network", () => {
  assert.throws(() => createGeminiMediaEdgeIsolatedGenerationCapability({
    edgeUrl: "https://edge.example.test/media",
    tenantId: "tenant-a",
    callControlId: "call-a",
    controlPlaneToken: "control-secret",
  }), /must use wss/);
  assert.throws(() => createGeminiMediaEdgeIsolatedGenerationCapability({
    edgeUrl: "wss://user:pass@edge.example.test/media",
    tenantId: "tenant-a",
    callControlId: "call-a",
    controlPlaneToken: "control-secret",
  }), /must not contain credentials/);
});
