import test from "node:test";
import assert from "node:assert/strict";
import { TelnyxGeminiStreamingRuntime } from "../.test-dist/telnyx-gemini-streaming-port.js";

function host(env = {}) {
  return { env };
}

function response(status, body = "") {
  return new Response(status === 204 ? null : body, { status });
}

test("Gemini streaming_start fixes the Telnyx media contract and authenticates the WSS edge", async () => {
  const calls = [];
  const runtime = new TelnyxGeminiStreamingRuntime(
    host({ TELNYX_API_KEY: "tel-key" }),
    async (url, init) => {
      calls.push({ url: String(url), init });
      return response(200, JSON.stringify({ data: { result: "ok" } }));
    },
  );

  const result = await runtime.start({
    callControlId: "call/1",
    streamUrl: "wss://media.example.test/telnyx/gemini",
    streamAuthToken: "edge-secret",
    targetLegs: "self",
    commandId: "stream-start-1",
    clientState: "c3RhdGU=",
  });

  assert.deepEqual(result, { ok: true, httpStatus: 200, alreadyEnded: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/calls\/call%2F1\/actions\/streaming_start$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tel-key");

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    stream_url: "wss://media.example.test/telnyx/gemini",
    stream_track: "inbound_track",
    stream_codec: "L16",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "L16",
    stream_bidirectional_sampling_rate: 16000,
    stream_bidirectional_target_legs: "self",
    stream_auth_token: "edge-secret",
    command_id: "stream-start-1",
    client_state: "c3RhdGU=",
  });
});

test("Gemini streaming_start rejects insecure or unauthenticated media edges before Telnyx effects", async () => {
  const calls = [];
  const runtime = new TelnyxGeminiStreamingRuntime(
    host({ TELNYX_API_KEY: "tel-key" }),
    async (...args) => {
      calls.push(args);
      return response(200);
    },
  );

  const insecure = await runtime.start({
    callControlId: "call-1",
    streamUrl: "ws://media.example.test/telnyx/gemini",
    streamAuthToken: "edge-secret",
    targetLegs: "self",
    commandId: "cmd-1",
  });
  assert.equal(insecure.ok, false);
  assert.match(insecure.error, /must use wss:\/\//);

  const unauthenticated = await runtime.start({
    callControlId: "call-1",
    streamUrl: "wss://media.example.test/telnyx/gemini",
    streamAuthToken: "   ",
    targetLegs: "self",
    commandId: "cmd-2",
  });
  assert.equal(unauthenticated.ok, false);
  assert.match(unauthenticated.error, /stream auth token is required/);
  assert.deepEqual(calls, []);
});

test("Gemini streaming target leg is explicit and invalid values fail closed", async () => {
  let called = false;
  const runtime = new TelnyxGeminiStreamingRuntime(
    host({ TELNYX_API_KEY: "tel-key" }),
    async () => {
      called = true;
      return response(200);
    },
  );

  const result = await runtime.start({
    callControlId: "call-1",
    streamUrl: "wss://media.example.test/telnyx/gemini",
    streamAuthToken: "edge-secret",
    targetLegs: "caller",
    commandId: "cmd-1",
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /target legs are invalid/);
  assert.equal(called, false);
});

test("Gemini streaming_stop can target the exact stream identity", async () => {
  const calls = [];
  const runtime = new TelnyxGeminiStreamingRuntime(
    host({ TELNYX_API_KEY: "tel-key" }),
    async (url, init) => {
      calls.push({ url: String(url), init });
      return response(200);
    },
  );

  const result = await runtime.stop({
    callControlId: "call-1",
    streamId: "1edb94f9-7ef0-4150-b502-e0ebadfd9491",
    commandId: "stream-stop-1",
    clientState: "c3RhdGU=",
  });

  assert.deepEqual(result, { ok: true, httpStatus: 200, alreadyEnded: false });
  assert.match(calls[0].url, /\/calls\/call-1\/actions\/streaming_stop$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    command_id: "stream-stop-1",
    stream_id: "1edb94f9-7ef0-4150-b502-e0ebadfd9491",
    client_state: "c3RhdGU=",
  });
});

test("Telnyx 422 is represented as an ended call instead of invented streaming success", async () => {
  const runtime = new TelnyxGeminiStreamingRuntime(
    host({ TELNYX_API_KEY: "tel-key" }),
    async () => response(422, JSON.stringify({ errors: [{ code: "90018" }] })),
  );

  const result = await runtime.start({
    callControlId: "ended-call",
    streamUrl: "wss://media.example.test/telnyx/gemini",
    streamAuthToken: "edge-secret",
    targetLegs: "self",
    commandId: "stream-start-ended",
  });

  assert.equal(result.ok, false);
  assert.equal(result.alreadyEnded, true);
  assert.equal(result.httpStatus, 422);
});

test("Telnyx streaming fetch is invoked as a bare dependency", async () => {
  const receiverSensitiveFetch = async function () {
    assert.equal(this, undefined);
    return response(200);
  };
  const runtime = new TelnyxGeminiStreamingRuntime(
    host({ TELNYX_API_KEY: "tel-key" }),
    receiverSensitiveFetch,
  );

  const result = await runtime.start({
    callControlId: "call-1",
    streamUrl: "wss://media.example.test/telnyx/gemini",
    streamAuthToken: "edge-secret",
    targetLegs: "self",
    commandId: "cmd-1",
  });
  assert.equal(result.ok, true);
});
