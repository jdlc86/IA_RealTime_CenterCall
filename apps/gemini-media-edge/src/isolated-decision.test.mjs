import test from "node:test";
import assert from "node:assert/strict";
import { createGeminiIsolatedDecisionClient } from "./isolated-decision.mjs";

test("isolated decision uses a one-shot generateContent request without leaking API key into URL", async () => {
  const calls = [];
  const client = createGeminiIsolatedDecisionClient({
    apiKey: "secret-api-key",
    model: "gemini-2.5-flash-lite",
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "IGNORE_CONFIRMED" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.decide({
    instructions: "Return one classifier label.",
    inputText: "Transcripción: ruido de fondo",
    maxOutputTokens: 8,
  });

  assert.equal(result, "IGNORE_CONFIRMED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent");
  assert.equal(calls[0].url.includes("secret-api-key"), false);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "secret-api-key");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "Return one classifier label." }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "Transcripción: ruido de fondo" }] }]);
  assert.deepEqual(body.generationConfig, { temperature: 0, maxOutputTokens: 8, responseMimeType: "text/plain" });
});

test("isolated decision is fail-closed on transport, HTTP, malformed JSON and empty output", async () => {
  const request = { instructions: "classify", inputText: "hello" };
  const transport = createGeminiIsolatedDecisionClient({ apiKey: "k", fetcher: async () => { throw new Error("network"); } });
  await assert.rejects(() => transport.decide(request), /request failed/);

  const http = createGeminiIsolatedDecisionClient({ apiKey: "k", fetcher: async () => new Response("no", { status: 503 }) });
  await assert.rejects(() => http.decide(request), /HTTP 503/);

  const malformed = createGeminiIsolatedDecisionClient({ apiKey: "k", fetcher: async () => new Response("not-json", { status: 200 }) });
  await assert.rejects(() => malformed.decide(request), /invalid JSON/);

  const empty = createGeminiIsolatedDecisionClient({ apiKey: "k", fetcher: async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }) });
  await assert.rejects(() => empty.decide(request), /returned no text/);
});

test("isolated decision validates bounded text-decision inputs before network", async () => {
  let calls = 0;
  const client = createGeminiIsolatedDecisionClient({ apiKey: "k", fetcher: async () => { calls += 1; return new Response("{}", { status: 200 }); } });
  await assert.rejects(() => client.decide({ instructions: "", inputText: "x" }), /instructions is required/);
  await assert.rejects(() => client.decide({ instructions: "x", inputText: "" }), /input is required/);
  await assert.rejects(() => client.decide({ instructions: "x", inputText: "y", maxOutputTokens: 1000 }), /maxOutputTokens is invalid/);
  assert.equal(calls, 0);
});
