import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleTextToSpeechSynthesizer, decodeLinear16Wav } from "./google-text-to-speech.mjs";

function linear16Wav(pcm, overrides = {}) {
  const payload = Buffer.from(pcm);
  const bytes = Buffer.alloc(44 + payload.length + (payload.length % 2));
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(overrides.audioFormat ?? 1, 20);
  bytes.writeUInt16LE(overrides.channels ?? 1, 22);
  bytes.writeUInt32LE(overrides.sampleRateHertz ?? 16_000, 24);
  bytes.writeUInt32LE(overrides.byteRate ?? 32_000, 28);
  bytes.writeUInt16LE(overrides.blockAlign ?? 2, 32);
  bytes.writeUInt16LE(overrides.bitsPerSample ?? 16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(payload.length, 40);
  payload.copy(bytes, 44);
  return bytes;
}

function synthesizer(overrides = {}) {
  const calls = [];
  const synthesize = createGoogleTextToSpeechSynthesizer({
    projectId: "project-1",
    languageCode: "es-ES",
    voiceName: "es-ES-test-voice",
    accessTokenProvider: async () => "oauth-secret",
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ audioContent: linear16Wav([1, 2, 3, 4]).toString("base64") }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    ...overrides,
  });
  return { synthesize, calls };
}

test("governed TTS requests documented LINEAR16 and returns validated headerless PCM", async () => {
  const { synthesize, calls } = synthesizer();
  const result = await synthesize({ text: "  Su reserva está confirmada.  " });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://texttospeech.googleapis.com/v1/text:synthesize");
  assert.doesNotMatch(calls[0].url, /oauth-secret/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer oauth-secret");
  assert.equal(calls[0].init.headers["x-goog-user-project"], "project-1");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    input: { text: "Su reserva está confirmada." },
    voice: { languageCode: "es-ES", name: "es-ES-test-voice" },
    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 16000 },
  });
  assert.deepEqual([...result.pcm16le], [1, 2, 3, 4]);
  assert.equal(result.sampleRateHertz, 16000);
  assert.equal(result.encoding, "PCM16_LE");
});

test("governed TTS rejects empty or oversized text before credentials or network", async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const { synthesize } = synthesizer({
    maxTextChars: 8,
    accessTokenProvider: async () => { tokenCalls += 1; return "oauth-secret"; },
    fetcher: async () => { fetchCalls += 1; throw new Error("must not run"); },
  });
  await assert.rejects(() => synthesize({ text: "" }), /text is required/);
  await assert.rejects(() => synthesize({ text: "123456789" }), /configured limit/);
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("governed TTS fails closed on credential, transport and HTTP errors without leaking secrets or bodies", async () => {
  const credentialFailure = synthesizer({ accessTokenProvider: async () => { throw new Error("oauth-super-secret"); } }).synthesize;
  await assert.rejects(credentialFailure({ text: "Hola" }), (error) => {
    assert.match(error.message, /access token acquisition failed/);
    assert.doesNotMatch(error.message, /oauth-super-secret/);
    return true;
  });

  const transportFailure = synthesizer({ fetcher: async () => { throw new Error("provider-secret-body"); } }).synthesize;
  await assert.rejects(transportFailure({ text: "Hola" }), (error) => {
    assert.equal(error.message, "Google Text-to-Speech synthesis request failed");
    assert.doesNotMatch(error.message, /provider-secret-body/);
    return true;
  });

  const httpFailure = synthesizer({ fetcher: async () => new Response("private-provider-body", { status: 503 }) }).synthesize;
  await assert.rejects(httpFailure({ text: "Hola" }), (error) => {
    assert.equal(error.message, "Google Text-to-Speech synthesis failed with HTTP 503");
    assert.doesNotMatch(error.message, /private-provider-body/);
    return true;
  });
});

test("governed TTS rejects malformed PCM responses and enforces bounded audio", async () => {
  const compressed = synthesizer({ fetcher: async () => new Response(JSON.stringify({ audioContent: Buffer.from([0xff, 0xf3, 0x88, 0xc4]).toString("base64") }), { status: 200 }) }).synthesize;
  await assert.rejects(() => compressed({ text: "Hola" }), /unsupported audio container/);

  const odd = synthesizer({ fetcher: async () => new Response(JSON.stringify({ audioContent: linear16Wav([1, 2, 3]).toString("base64") }), { status: 200 }) }).synthesize;
  await assert.rejects(() => odd({ text: "Hola" }), /invalid PCM16 audio/);

  const tooLarge = synthesizer({
    maxAudioBytes: 4,
    fetcher: async () => new Response(JSON.stringify({ audioContent: linear16Wav(Buffer.alloc(6)).toString("base64") }), { status: 200 }),
  }).synthesize;
  await assert.rejects(() => tooLarge({ text: "Hola" }), /audio exceeds the configured limit/);
});

test("LINEAR16 WAV extraction fails closed on metadata mismatch and truncation", () => {
  assert.throws(
    () => decodeLinear16Wav(linear16Wav([1, 2], { sampleRateHertz: 24_000 }).toString("base64"), 1024),
    /unsupported WAV format/,
  );
  const truncated = linear16Wav([1, 2, 3, 4]).subarray(0, 46);
  assert.throws(() => decodeLinear16Wav(truncated.toString("base64"), 1024), /invalid WAV length/);
});

test("governed TTS validates configuration before any external effect", () => {
  assert.throws(() => createGoogleTextToSpeechSynthesizer({}), /GOOGLE_CLOUD_PROJECT_ID is required/);
  assert.throws(() => createGoogleTextToSpeechSynthesizer({ projectId: "project/unsafe" }), /GOOGLE_CLOUD_PROJECT_ID is invalid/);
  assert.throws(() => createGoogleTextToSpeechSynthesizer({ projectId: "project-1", languageCode: "es-ES", voiceName: "voice", accessTokenProvider: async () => "x", maxTextChars: 0 }), /text limit is invalid/);
});
