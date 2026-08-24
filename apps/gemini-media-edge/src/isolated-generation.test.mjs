import test from "node:test";
import assert from "node:assert/strict";
import {
  createGeminiIsolatedGenerationClient,
  generateForActiveGeminiControlSession,
} from "./isolated-generation.mjs";

test("isolated generation uses one-shot generateContent without leaking API key into URL", async () => {
  const calls = [];
  const client = createGeminiIsolatedGenerationClient({
    apiKey: "secret-api-key",
    model: "gemini-2.5-flash-lite",
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "¿Quieres que te transfiera para confirmarlo con el restaurante?" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.generate({
    instructions: "Redacta una única frase breve y natural en español.",
    inputText: "Explica que el equipo del restaurante debe confirmar la necesidad y pregunta si desea transferencia.",
  });

  assert.equal(result, "¿Quieres que te transfiera para confirmarlo con el restaurante?");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent");
  assert.equal(calls[0].url.includes("secret-api-key"), false);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "secret-api-key");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "Redacta una única frase breve y natural en español." }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "Explica que el equipo del restaurante debe confirmar la necesidad y pregunta si desea transferencia." }] }]);
  assert.deepEqual(body.generationConfig, { temperature: 0.2, maxOutputTokens: 96, responseMimeType: "text/plain" });
});

test("isolated generation fails closed on transport, HTTP, malformed JSON, empty and oversized output", async () => {
  const request = { instructions: "write", inputText: "hello" };
  const transport = createGeminiIsolatedGenerationClient({ apiKey: "k", fetcher: async () => { throw new Error("network"); } });
  await assert.rejects(() => transport.generate(request), /request failed/);

  const http = createGeminiIsolatedGenerationClient({ apiKey: "k", fetcher: async () => new Response("no", { status: 503 }) });
  await assert.rejects(() => http.generate(request), /HTTP 503/);

  const malformed = createGeminiIsolatedGenerationClient({ apiKey: "k", fetcher: async () => new Response("not-json", { status: 200 }) });
  await assert.rejects(() => malformed.generate(request), /invalid JSON/);

  const empty = createGeminiIsolatedGenerationClient({ apiKey: "k", fetcher: async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }) });
  await assert.rejects(() => empty.generate(request), /returned no text/);

  const oversized = createGeminiIsolatedGenerationClient({
    apiKey: "k",
    maxOutputChars: 8,
    fetcher: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "123456789" }] } }] }), { status: 200 }),
  });
  await assert.rejects(() => oversized.generate(request), /output exceeds/);
});

test("isolated generation validates bounds before network and requires the exact active control session", async () => {
  let calls = 0;
  const client = createGeminiIsolatedGenerationClient({
    apiKey: "k",
    maxInputChars: 20,
    fetcher: async () => {
      calls += 1;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hola" }] } }] }), { status: 200 });
    },
  });
  await assert.rejects(() => client.generate({ instructions: "", inputText: "x" }), /instructions is required/);
  await assert.rejects(() => client.generate({ instructions: "x", inputText: "" }), /input is required/);
  await assert.rejects(() => client.generate({ instructions: "x", inputText: "y", maxOutputTokens: 1000 }), /maxOutputTokens is invalid/);
  assert.equal(calls, 0);

  const registry = {
    isActive({ tenantId, callControlId }) {
      return tenantId === "tenant-a" && callControlId === "call-a";
    },
  };
  await assert.rejects(
    () => generateForActiveGeminiControlSession(registry, client, {
      tenantId: "tenant-a",
      callControlId: "call-b",
      instructions: "x",
      inputText: "y",
    }),
    /requires an active control session/,
  );
  assert.equal(calls, 0);

  const text = await generateForActiveGeminiControlSession(registry, client, {
    tenantId: "tenant-a",
    callControlId: "call-a",
    instructions: "x",
    inputText: "y",
  });
  assert.equal(text, "Hola");
  assert.equal(calls, 1);
});
