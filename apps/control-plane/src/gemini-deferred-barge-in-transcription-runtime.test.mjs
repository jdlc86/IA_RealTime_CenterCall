import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createAuthoritativeCallerTranscriptionPort } from "../.test-dist/authoritative-caller-transcription-port.js";
import { GeminiDeferredBargeInTranscriptionRuntime } from "../.test-dist/gemini-deferred-barge-in-transcription-runtime.js";

const source = readFileSync(new URL("./gemini-deferred-barge-in-transcription-runtime.ts", import.meta.url), "utf8");

function transcriptionPort(delegate) {
  return createAuthoritativeCallerTranscriptionPort({ transcribe: delegate });
}

test("deferred runtime emits caller transcript completion only through authoritative STT", async () => {
  let observed = null;
  const runtime = new GeminiDeferredBargeInTranscriptionRuntime(transcriptionPort(async (request) => {
    observed = request;
    return { itemId: request.itemId, transcript: "  quiero   reservar  " };
  }));

  const started = runtime.beginCandidate();
  runtime.bufferTelnyxMedia("AAE=");
  runtime.bufferTelnyxMedia("AAI=");
  assert.deepEqual(await runtime.completeAuthoritativeTranscript(), [
    { type: "CALLER_SPEECH_STOPPED" },
    { type: "CALLER_TRANSCRIPT_COMPLETED", transcript: "quiero reservar", itemId: started.itemId },
  ]);
  assert.deepEqual(observed, {
    itemId: started.itemId,
    audio: {
      encoding: "PCM16_BE",
      sampleRateHz: 16000,
      channels: 1,
      payloads: ["AAE=", "AAI="],
    },
  });
  assert.equal(runtime.snapshot().candidate.transcriptReady, true);
});

test("confirmed candidate returned by composed runtime preserves exact transcribed audio", async () => {
  const runtime = new GeminiDeferredBargeInTranscriptionRuntime(transcriptionPort(async (request) => ({
    itemId: request.itemId,
    transcript: "espera",
  })));
  const started = runtime.beginCandidate();
  runtime.bufferTelnyxMedia("AAE=");
  await runtime.completeAuthoritativeTranscript();
  assert.deepEqual(runtime.confirmInterruption(started.itemId), {
    itemId: started.itemId,
    transcript: "espera",
    mediaPayloads: ["AAE="],
  });
});

test("duplicate transcription and semantic release are blocked while STT is in flight", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const runtime = new GeminiDeferredBargeInTranscriptionRuntime(transcriptionPort(async (request) => {
    await pending;
    return { itemId: request.itemId, transcript: "hola" };
  }));
  const started = runtime.beginCandidate();
  runtime.bufferTelnyxMedia("AAE=");

  const first = runtime.completeAuthoritativeTranscript();
  await Promise.resolve();
  assert.equal(runtime.snapshot().transcriptionInFlightItemId, started.itemId);
  await assert.rejects(() => runtime.completeAuthoritativeTranscript(), /already in flight/);
  assert.throws(() => runtime.confirmInterruption(started.itemId), /while transcription is in flight/);
  assert.throws(() => runtime.ignoreCandidate(started.itemId), /while transcription is in flight/);

  release();
  await first;
  assert.equal(runtime.snapshot().transcriptionInFlightItemId, null);
});

test("STT failure releases only the in-flight lock and preserves candidate audio for explicit recovery", async () => {
  const runtime = new GeminiDeferredBargeInTranscriptionRuntime(transcriptionPort(async () => {
    throw new Error("stt unavailable");
  }));
  const started = runtime.beginCandidate();
  runtime.bufferTelnyxMedia("AAE=");

  await assert.rejects(() => runtime.completeAuthoritativeTranscript(), /stt unavailable/);
  assert.deepEqual(runtime.snapshot(), {
    candidate: {
      activeItemId: started.itemId,
      sequence: 1,
      bufferedChunks: 1,
      bufferedPayloadChars: 4,
      transcriptReady: false,
    },
    transcriptionInFlightItemId: null,
  });
  assert.throws(() => runtime.confirmInterruption(started.itemId), /before transcript completion/);
});

test("runtime cannot infer completion from Gemini Live protocol or timing", () => {
  assert.doesNotMatch(source, /inputTranscription|turnComplete|generationComplete|activityEnd|serverContent/);
  assert.doesNotMatch(source, /setTimeout\s*\(|\bsleep\s*\(/);
});
