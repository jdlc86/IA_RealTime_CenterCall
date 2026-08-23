import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { GeminiDeferredBargeInCandidateOwner } from "../.test-dist/gemini-deferred-barge-in-candidate-owner.js";

const source = readFileSync(new URL("./gemini-deferred-barge-in-candidate-owner.ts", import.meta.url), "utf8");

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

test("authoritative transcript completes the same neutral candidate before semantic decision", () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const started = owner.beginCandidate();
  owner.bufferTelnyxMedia("AAEC");
  owner.bufferTelnyxMedia("AwQF");

  assert.deepEqual(owner.completeCandidate("  quiero   reservar mañana  "), [
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

test("confirmed interruption releases an immutable replay candidate only after transcript completion", () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const started = owner.beginCandidate();
  owner.bufferTelnyxMedia("AQID");
  assert.throws(
    () => owner.confirmInterruption(started.itemId),
    /cannot commit before transcript completion/,
  );

  owner.completeCandidate("sí, espera");
  const committed = owner.confirmInterruption(started.itemId);
  assert.deepEqual(committed, {
    itemId: started.itemId,
    transcript: "sí, espera",
    mediaPayloads: ["AQID"],
  });
  assert.equal(Object.isFrozen(committed), true);
  assert.equal(Object.isFrozen(committed.mediaPayloads), true);
  assert.equal(owner.snapshot().activeItemId, null);
});

test("ignored candidate is discarded without exposing buffered audio for provider replay", () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const started = owner.beginCandidate();
  owner.bufferTelnyxMedia("AQID");
  owner.completeCandidate("eh");
  assert.deepEqual(owner.ignoreCandidate(started.itemId), {
    activeItemId: null,
    sequence: 1,
    bufferedChunks: 0,
    bufferedPayloadChars: 0,
    transcriptReady: false,
  });
  assert.throws(() => owner.confirmInterruption(started.itemId), /is not active/);
});

test("candidate identity is one-shot and mismatches fail closed", () => {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const first = owner.beginCandidate();
  assert.throws(() => owner.beginCandidate(), /already active/);
  assert.throws(() => owner.ignoreCandidate("gemini-candidate-999"), /identity mismatch/);
  owner.completeCandidate("hola");
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
