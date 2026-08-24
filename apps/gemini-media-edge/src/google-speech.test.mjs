import test from "node:test";
import assert from "node:assert/strict";
import { createCloudRunAccessTokenProvider, createGoogleSpeechV2Transcriber } from "./google-speech.mjs";

test("Cloud Run token provider uses metadata identity and caches safely", async () => {
  let calls = 0;
  let now = 1_000;
  const provider = createCloudRunAccessTokenProvider(async (url, init) => {
    calls += 1;
    assert.equal(url, "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    assert.equal(init.headers["Metadata-Flavor"], "Google");
    return { ok: true, status: 200, async json() { return { access_token: `token-${calls}`, expires_in: 3600 }; } };
  }, () => now);
  assert.equal(await provider(), "token-1");
  assert.equal(await provider(), "token-1");
  assert.equal(calls, 1);
  now += 3_600_000;
  assert.equal(await provider(), "token-2");
  assert.equal(calls, 2);
});

test("Speech v2 receives exact Telnyx PCM16 little-endian bytes without swapping", async () => {
  const requests = [];
  const transcribe = createGoogleSpeechV2Transcriber({
    projectId: "project-test",
    languageCodes: ["es-ES"],
    accessTokenProvider: async () => "test-access-token",
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, async json() { return { results: [{ alternatives: [{ transcript: "  hola   mundo " }] }] }; } };
    },
  });
  const pcm16le = Buffer.from([0x12, 0x34, 0xab, 0xcd]).toString("base64");
  assert.deepEqual(await transcribe({ itemId: "candidate-1", payloads: [pcm16le] }), { itemId: "candidate-1", transcript: "hola mundo" });
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual([...Buffer.from(body.content, "base64")], [0x12, 0x34, 0xab, 0xcd]);
  assert.deepEqual(body.config.explicitDecodingConfig, { encoding: "LINEAR16", sampleRateHertz: 16000, audioChannelCount: 1 });
  assert.equal(body.config.model, "telephony_short");
  assert.equal(requests[0].init.headers.Authorization, "Bearer test-access-token");
});

test("Speech v2 always sends an explicit configured model", async () => {
  let body;
  const transcribe = createGoogleSpeechV2Transcriber({
    projectId: "project-test",
    model: "short",
    languageCodes: ["es-ES"],
    accessTokenProvider: async () => "token",
    fetcher: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, async json() { return { results: [{ alternatives: [{ transcript: "hola" }] }] }; } };
    },
  });
  await transcribe({ itemId: "candidate-1", payloads: [Buffer.from([0, 1]).toString("base64")] });
  assert.equal(body.config.model, "short");
});

test("Speech adapter rejects identity-less or empty recognition evidence", async () => {
  const transcribe = createGoogleSpeechV2Transcriber({
    projectId: "project-test",
    languageCodes: ["es-ES"],
    accessTokenProvider: async () => "token",
    fetcher: async () => ({ ok: true, status: 200, async json() { return { results: [] }; } }),
  });
  const audio = Buffer.from([0, 1]).toString("base64");
  await assert.rejects(transcribe({ itemId: "candidate-1", payloads: [audio] }), /returned no transcript/);
});
