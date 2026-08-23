import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { GoogleCloudSpeechV2TranscriptionAdapter } from "../.test-dist/google-cloud-speech-v2-transcription-adapter.js";

const source = readFileSync(new URL("./google-cloud-speech-v2-transcription-adapter.ts", import.meta.url), "utf8");

function request(payloads = [Buffer.from([0x00, 0x01, 0x00, 0x02]).toString("base64")]) {
  return {
    itemId: "gemini-candidate-7",
    audio: {
      encoding: "PCM16_BE",
      sampleRateHz: 16000,
      channels: 1,
      payloads,
    },
  };
}

function responseJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Google Cloud STT v2 request converts Telnyx big-endian PCM to LINEAR16 little-endian", async () => {
  let captured = null;
  const adapter = new GoogleCloudSpeechV2TranscriptionAdapter({
    projectId: "voice-project",
    languageCodes: ["es-ES"],
    model: "short",
    accessTokenProvider: async () => "access-token",
    fetcher: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return responseJson({
        results: [
          { alternatives: [{ transcript: "  quiero una " }] },
          { alternatives: [{ transcript: " mesa mañana  " }] },
        ],
      });
    },
  });

  assert.deepEqual(await adapter.transcribe(request()), {
    itemId: "gemini-candidate-7",
    transcript: "quiero una mesa mañana",
  });
  assert.equal(
    captured.url,
    "https://speech.googleapis.com/v2/projects/voice-project/locations/global/recognizers/_:recognize",
  );
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer access-token");
  assert.deepEqual(captured.body.config, {
    explicitDecodingConfig: {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      audioChannelCount: 1,
    },
    languageCodes: ["es-ES"],
    model: "short",
  });
  assert.deepEqual([...Buffer.from(captured.body.content, "base64")], [0x01, 0x00, 0x02, 0x00]);
});

test("multiple Telnyx payloads preserve sample order across endian conversion", async () => {
  let content = null;
  const adapter = new GoogleCloudSpeechV2TranscriptionAdapter({
    projectId: "voice-project",
    location: "eu",
    recognizer: "callcenter",
    languageCodes: ["es-ES", "en-US"],
    accessTokenProvider: async () => "token",
    fetcher: async (_url, init) => {
      content = JSON.parse(init.body).content;
      return responseJson({ results: [{ alternatives: [{ transcript: "hola" }] }] });
    },
  });

  await adapter.transcribe(request([
    Buffer.from([0x00, 0x01]).toString("base64"),
    Buffer.from([0x00, 0x02]).toString("base64"),
  ]));
  assert.deepEqual([...Buffer.from(content, "base64")], [0x01, 0x00, 0x02, 0x00]);
});

test("incomplete PCM sample fails before credentials or network are touched", async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const adapter = new GoogleCloudSpeechV2TranscriptionAdapter({
    projectId: "voice-project",
    languageCodes: ["es-ES"],
    accessTokenProvider: async () => { tokenCalls += 1; return "token"; },
    fetcher: async () => { fetchCalls += 1; return responseJson({}); },
  });

  await assert.rejects(
    () => adapter.transcribe(request([Buffer.from([0x00]).toString("base64")])),
    /complete PCM16 samples/,
  );
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("wrong source audio contract fails closed before provider access", async () => {
  let fetchCalls = 0;
  const adapter = new GoogleCloudSpeechV2TranscriptionAdapter({
    projectId: "voice-project",
    languageCodes: ["es-ES"],
    accessTokenProvider: async () => "token",
    fetcher: async () => { fetchCalls += 1; return responseJson({}); },
  });
  await assert.rejects(
    () => adapter.transcribe({
      itemId: "x",
      audio: { encoding: "LINEAR16", sampleRateHz: 16000, channels: 1, payloads: ["AAE="] },
    }),
    /requires mono PCM16 big-endian/,
  );
  assert.equal(fetchCalls, 0);
});

test("credential and transport failures never echo access tokens", async () => {
  const secret = "very-secret-google-token";
  const acquisition = new GoogleCloudSpeechV2TranscriptionAdapter({
    projectId: "voice-project",
    languageCodes: ["es-ES"],
    accessTokenProvider: async () => { throw new Error(secret); },
    fetcher: async () => responseJson({}),
  });
  await assert.rejects(
    () => acquisition.transcribe(request()),
    (error) => error instanceof Error && /acquisition failed/.test(error.message) && !error.message.includes(secret),
  );

  const transport = new GoogleCloudSpeechV2TranscriptionAdapter({
    projectId: "voice-project",
    languageCodes: ["es-ES"],
    accessTokenProvider: async () => secret,
    fetcher: async () => { throw new Error(`network ${secret}`); },
  });
  await assert.rejects(
    () => transport.transcribe(request()),
    (error) => error instanceof Error && /request failed/.test(error.message) && !error.message.includes(secret),
  );
});

test("HTTP and malformed-provider responses fail closed without response-body leakage", async () => {
  const http = new GoogleCloudSpeechV2TranscriptionAdapter({
    projectId: "voice-project",
    languageCodes: ["es-ES"],
    accessTokenProvider: async () => "token",
    fetcher: async () => responseJson({ secret_provider_detail: "do-not-echo" }, 503),
  });
  await assert.rejects(
    () => http.transcribe(request()),
    (error) => error instanceof Error && /HTTP 503/.test(error.message) && !error.message.includes("do-not-echo"),
  );

  const empty = new GoogleCloudSpeechV2TranscriptionAdapter({
    projectId: "voice-project",
    languageCodes: ["es-ES"],
    accessTokenProvider: async () => "token",
    fetcher: async () => responseJson({ results: [] }),
  });
  await assert.rejects(() => empty.transcribe(request()), /returned no transcript/);
});

test("constructor rejects unsafe resource segments and language configuration", () => {
  const base = {
    languageCodes: ["es-ES"],
    accessTokenProvider: async () => "token",
  };
  assert.throws(
    () => new GoogleCloudSpeechV2TranscriptionAdapter({ ...base, projectId: "bad/project" }),
    /projectId is invalid/,
  );
  assert.throws(
    () => new GoogleCloudSpeechV2TranscriptionAdapter({ ...base, projectId: "ok", languageCodes: [] }),
    /at least one language code/,
  );
});

test("adapter is Cloud STT-specific but contains no Gemini credential or traffic enablement", () => {
  assert.match(source, /speech\.googleapis\.com/);
  assert.match(source, /LINEAR16/);
  assert.doesNotMatch(source, /GEMINI_API_KEY|generativelanguage\.googleapis\.com|ENABLED_REALTIME_PROVIDERS/);
  assert.doesNotMatch(source, /setTimeout\s*\(|\bsleep\s*\(/);
});
