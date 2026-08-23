import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createAuthoritativeCallerTranscriptionPort } from "../.test-dist/authoritative-caller-transcription-port.js";
import {
  GeminiDeferredBargeInCandidateOwner,
  requireConfirmedGeminiDeferredBargeInCandidate,
} from "../.test-dist/gemini-deferred-barge-in-candidate-owner.js";

const source = readFileSync(new URL("./gemini-deferred-barge-in-candidate-owner.ts", import.meta.url), "utf8");

async function transcriptEvidence(owner, transcript) {
  const port = createAuthoritativeCallerTranscriptionPort({
    async transcribe(input) {
      return { itemId: input.itemId, transcript };
    },
  });
  return port.transcribe(owner.transcriptionRequest());
}

test("acoustic candidate emits neutral identity without any Gemini wire operation", () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  assert.deepEqual(owner.beginCandidate(), {
    type: "CALLER_SPEECH_STARTED",
    itemId: "gemini-candidate-1",
  });
  owner.bufferTelnyxMedia("AQID");
  assert.deepEqual(owner.snapshot(), {
    activeItemId: "gemini-candidate-1",
    sequence: 1,
    bufferedChunks: 1,
    bufferedPayloadChars: 4,
    transcriptReady: false,
  });

  assert.doesNotMatch(source, /\.send\s*\(/);
  assert.doesNotMatch(source, /GeminiLiveCommandHost/);
  assert.doesNotMatch(source, /telnyxL16PayloadToGeminiRealtimeInput/);
  assert.doesNotMatch(source, /setTimeout\s*\(|\bsleep\s*\(/);
});

test("transcription request is minted from the exact buffered big-endian candidate audio", () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  owner.beginCandidate();
  owner.bufferTelnyxMedia("AAEC");
  owner.bufferTelnyxMedia("AwQF");
  const request = owner.transcriptionRequest();
  assert.deepEqual(request, {
    itemId: "gemini-candidate-1",
    audio: {
      encoding: "PCM16_BE",
      sampleRateHz: 16000,
      channels: 1,
      payloads: ["AAEC", "AwQF"],
    },
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.audio), true);
  assert.equal(Object.isFrozen(request.audio.payloads), true);
});

test("authoritative transcript completes the same neutral candidate before semantic decision", async () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const started = owner.beginCandidate();
  owner.bufferTelnyxMedia("AAEC");
  owner.bufferTelnyxMedia("AwQF");
  const evidence = await transcriptEvidence(owner, "  quiero   reservar mañana  ");

  assert.deepEqual(owner.completeCandidate(evidence), [
    { type: "CALLER_SPEECH_STOPPED" },
    {
      type: "CALLER_TRANSCRIPT_COMPLETED",
      transcript: "quiero reservar mañana",
      itemId: started.itemId,
    },
  ]);
  assert.equal(owner.snapshot().transcriptReady, true);
  assert.throws(() => owner.bufferTelnyxMedia("BgcI"), /already completed/);
});

test("candidate cannot request transcription without replayable buffered audio", () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  owner.beginCandidate();
  assert.throws(() => owner.transcriptionRequest(), /without buffered audio/);
});

test("raw transcript text cannot bypass authoritative evidence", () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  owner.beginCandidate();
  owner.bufferTelnyxMedia("AQID");
  assert.throws(() => owner.completeCandidate("hola"), /not authoritative transcription evidence/);
});

test("authoritative evidence for different audio cannot complete a same-id candidate", async () => {
  const target = new GeminiDeferredBargeInCandidateOwner();
  target.beginCandidate();
  target.bufferTelnyxMedia("AAAA");

  const other = new GeminiDeferredBargeInCandidateOwner();
  other.beginCandidate();
  other.bufferTelnyxMedia("BBBB");
  const wrongAudioEvidence = await transcriptEvidence(other, "hola");

  assert.throws(() => target.completeCandidate(wrongAudioEvidence), /transcript audio mismatch/);
});

test("confirmed interruption releases an authenticated immutable replay candidate only after transcript completion", async () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const started = owner.beginCandidate();
  owner.bufferTelnyxMedia("AQID");
  assert.throws(
    () => owner.confirmInterruption(started.itemId),
    /cannot commit before transcript completion/,
  );

  owner.completeCandidate(await transcriptEvidence(owner, "sí, espera"));
  const committed = owner.confirmInterruption(started.itemId);
  assert.deepEqual(committed, {
    itemId: started.itemId,
    transcript: "sí, espera",
    mediaPayloads: ["AQID"],
  });
  assert.equal(requireConfirmedGeminiDeferredBargeInCandidate(committed), committed);
  assert.equal(Object.isFrozen(committed), true);
  assert.equal(Object.isFrozen(committed.mediaPayloads), true);
  assert.equal(owner.snapshot().activeItemId, null);
});

test("shape-compatible fabricated candidate is not semantically authorized", () => {
  assert.throws(
    () => requireConfirmedGeminiDeferredBargeInCandidate({
      itemId: "gemini-candidate-1",
      transcript: "hola",
      mediaPayloads: ["AQID"],
    }),
    /not semantically authorized/,
  );
});

test("ignored candidate is discarded without exposing buffered audio for provider replay", async () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const started = owner.beginCandidate();
  owner.bufferTelnyxMedia("AQID");
  owner.completeCandidate(await transcriptEvidence(owner, "eh"));
  assert.deepEqual(owner.ignoreCandidate(started.itemId), {
    activeItemId: null,
    sequence: 1,
    bufferedChunks: 0,
    bufferedPayloadChars: 0,
    transcriptReady: false,
  });
  assert.throws(() => owner.confirmInterruption(started.itemId), /is not active/);
});

test("candidate identity is one-shot and mismatches fail closed", async () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const first = owner.beginCandidate();
  assert.throws(() => owner.beginCandidate(), /already active/);
  assert.throws(() => owner.ignoreCandidate("gemini-candidate-999"), /identity mismatch/);
  owner.bufferTelnyxMedia("AQID");
  owner.completeCandidate(await transcriptEvidence(owner, "hola"));
  owner.ignoreCandidate(first.itemId);
  assert.equal(owner.beginCandidate().itemId, "gemini-candidate-2");
});

test("buffer growth is structurally bounded without timers", () => {
  const byChunks = new GeminiDeferredBargeInCandidateOwner(2, 100);
  byChunks.beginCandidate();
  byChunks.bufferTelnyxMedia("AAAA");
  byChunks.bufferTelnyxMedia("BBBB");
  assert.throws(() => byChunks.bufferTelnyxMedia("CCCC"), /chunk limit/);

  const byPayload = new GeminiDeferredBargeInCandidateOwner(10, 5);
  byPayload.beginCandidate();
  byPayload.bufferTelnyxMedia("AAAA");
  assert.throws(() => byPayload.bufferTelnyxMedia("BB"), /payload limit/);
});
