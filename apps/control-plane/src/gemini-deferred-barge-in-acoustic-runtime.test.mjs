import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createAuthoritativeCallerTranscriptionPort } from "../.test-dist/authoritative-caller-transcription-port.js";
import { GeminiDeferredBargeInAcousticRuntime } from "../.test-dist/gemini-deferred-barge-in-acoustic-runtime.js";

const source = readFileSync(new URL("./gemini-deferred-barge-in-acoustic-runtime.ts", import.meta.url), "utf8");

function pcm16be(sample, count) {
  const buffer = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) buffer.writeInt16BE(sample, index * 2);
  return buffer.toString("base64");
}

function config() {
  return {
    startRms: 0.10,
    stopRms: 0.04,
    minSpeechMs: 20,
    minSilenceMs: 20,
  };
}

function runtimeWith(delegate) {
  return new GeminiDeferredBargeInAcousticRuntime(
    createAuthoritativeCallerTranscriptionPort(delegate),
    config(),
  );
}

test("acoustic onset is replayed exactly once and one authoritative transcript closes the candidate", async () => {
  const sttRequests = [];
  const runtime = runtimeWith({
    async transcribe(request) {
      sttRequests.push(request);
      return { itemId: request.itemId, transcript: "  quiero   reservar  " };
    },
  });

  const onsetA = pcm16be(9000, 160);
  const onsetB = pcm16be(9000, 160);
  const speech = pcm16be(7000, 160);
  const silenceA = pcm16be(0, 160);
  const silenceB = pcm16be(0, 160);

  assert.deepEqual((await runtime.observeTelnyxMedia(onsetA)).events, []);
  const started = await runtime.observeTelnyxMedia(onsetB);
  assert.deepEqual(started.events, [{
    type: "CALLER_SPEECH_STARTED",
    itemId: "gemini-candidate-1",
  }]);
  assert.equal(started.snapshot.transcription.candidate.bufferedChunks, 2);

  assert.deepEqual((await runtime.observeTelnyxMedia(speech)).events, []);
  assert.deepEqual((await runtime.observeTelnyxMedia(silenceA)).events, []);
  const completed = await runtime.observeTelnyxMedia(silenceB);

  assert.deepEqual(completed.events, [
    { type: "CALLER_SPEECH_STOPPED" },
    {
      type: "CALLER_TRANSCRIPT_COMPLETED",
      transcript: "quiero reservar",
      itemId: "gemini-candidate-1",
    },
  ]);
  assert.equal(sttRequests.length, 1);
  assert.deepEqual(sttRequests[0].audio.payloads, [onsetA, onsetB, speech, silenceA, silenceB]);
  assert.equal(completed.snapshot.vad.state, "SILENCE");
  assert.equal(completed.snapshot.transcription.candidate.transcriptReady, true);
});

test("confirmed interruption remains downstream of completed authoritative STT", async () => {
  const runtime = runtimeWith({
    async transcribe(request) {
      return { itemId: request.itemId, transcript: "espera" };
    },
  });

  await runtime.observeTelnyxMedia(pcm16be(9000, 320));
  const itemId = runtime.snapshot().transcription.candidate.activeItemId;
  assert.equal(itemId, "gemini-candidate-1");
  assert.throws(() => runtime.confirmInterruption(itemId), /before transcript completion/);

  await runtime.observeTelnyxMedia(pcm16be(0, 320));
  const candidate = runtime.confirmInterruption(itemId);
  assert.equal(candidate.itemId, itemId);
  assert.equal(candidate.transcript, "espera");
  assert.equal(candidate.mediaPayloads.length, 2);
});

test("STT failure discards the candidate so a later acoustic intervention can start cleanly", async () => {
  let calls = 0;
  const runtime = runtimeWith({
    async transcribe(request) {
      calls += 1;
      if (calls === 1) throw new Error("synthetic stt failure");
      return { itemId: request.itemId, transcript: "segundo intento" };
    },
  });

  await runtime.observeTelnyxMedia(pcm16be(9000, 320));
  await assert.rejects(
    () => runtime.observeTelnyxMedia(pcm16be(0, 320)),
    /synthetic stt failure/,
  );
  assert.equal(runtime.snapshot().transcription.candidate.activeItemId, null);
  assert.equal(runtime.snapshot().vad.state, "SILENCE");

  const nextStart = await runtime.observeTelnyxMedia(pcm16be(9000, 320));
  assert.equal(nextStart.events[0]?.type, "CALLER_SPEECH_STARTED");
  assert.equal(nextStart.events[0]?.itemId, "gemini-candidate-2");
  const nextDone = await runtime.observeTelnyxMedia(pcm16be(0, 320));
  assert.equal(nextDone.events[1]?.type, "CALLER_TRANSCRIPT_COMPLETED");
  assert.equal(nextDone.events[1]?.itemId, "gemini-candidate-2");
});

test("background audio below onset never creates a caller candidate or STT request", async () => {
  let calls = 0;
  const runtime = runtimeWith({
    async transcribe(request) {
      calls += 1;
      return { itemId: request.itemId, transcript: "should not happen" };
    },
  });

  for (let index = 0; index < 8; index += 1) {
    const observation = await runtime.observeTelnyxMedia(pcm16be(500, 160));
    assert.deepEqual(observation.events, []);
  }
  assert.equal(calls, 0);
  assert.equal(runtime.snapshot().transcription.candidate.activeItemId, null);
});

test("acoustic composition adds no arrival-time heuristic or Gemini wire dependency", () => {
  assert.doesNotMatch(source, /setTimeout\s*\(|setInterval\s*\(|Date\.now\s*\(|\bsleep\s*\(/);
  assert.doesNotMatch(source, /GeminiLive|realtimeInput|clientContent|response\.create/);
});
