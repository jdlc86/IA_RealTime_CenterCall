import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createAuthoritativeCallerTranscriptionPort,
  requireAuthoritativeCallerTranscriptEvidence,
} from "../.test-dist/authoritative-caller-transcription-port.js";

const source = readFileSync(new URL("./authoritative-caller-transcription-port.ts", import.meta.url), "utf8");

function request(overrides = {}) {
  return {
    itemId: "gemini-candidate-1",
    audio: {
      encoding: "L16",
      sampleRateHz: 16000,
      channels: 1,
      payloads: ["AAE=", "AAI="],
    },
    ...overrides,
  };
}

test("transcription port freezes canonical candidate audio before delegate execution", async () => {
  let observed = null;
  const port = createAuthoritativeCallerTranscriptionPort({
    async transcribe(input) {
      observed = input;
      return { itemId: input.itemId, transcript: "  quiero   una mesa  " };
    },
  });

  const evidence = await port.transcribe(request());
  assert.deepEqual(observed, {
    itemId: "gemini-candidate-1",
    audio: {
      encoding: "L16",
      sampleRateHz: 16000,
      channels: 1,
      payloads: ["AAE=", "AAI="],
    },
  });
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.audio), true);
  assert.equal(Object.isFrozen(observed.audio.payloads), true);
  assert.deepEqual(evidence, {
    itemId: "gemini-candidate-1",
    transcript: "quiero una mesa",
  });
  assert.equal(requireAuthoritativeCallerTranscriptEvidence(evidence), evidence);
});

test("delegate cannot silently return transcript for another candidate", async () => {
  const port = createAuthoritativeCallerTranscriptionPort({
    async transcribe() {
      return { itemId: "gemini-candidate-999", transcript: "hola" };
    },
  });
  await assert.rejects(() => port.transcribe(request()), /identity mismatch/);
});

test("empty or malformed audio fails before external transcription", async () => {
  let calls = 0;
  const port = createAuthoritativeCallerTranscriptionPort({
    async transcribe(input) {
      calls += 1;
      return { itemId: input.itemId, transcript: "hola" };
    },
  });

  await assert.rejects(
    () => port.transcribe(request({ audio: { encoding: "L16", sampleRateHz: 16000, channels: 1, payloads: [] } })),
    /requires buffered audio/,
  );
  await assert.rejects(
    () => port.transcribe(request({ audio: { encoding: "L16", sampleRateHz: 16000, channels: 1, payloads: [" "] } })),
    /rejects empty audio payloads/,
  );
  assert.equal(calls, 0);
});

test("empty transcript result fails closed and is never minted as evidence", async () => {
  const port = createAuthoritativeCallerTranscriptionPort({
    async transcribe(input) {
      return { itemId: input.itemId, transcript: "   " };
    },
  });
  await assert.rejects(() => port.transcribe(request()), /returned empty transcript/);
});

test("shape-compatible transcript cannot bypass the authoritative boundary", () => {
  assert.throws(
    () => requireAuthoritativeCallerTranscriptEvidence({
      itemId: "gemini-candidate-1",
      transcript: "hola",
    }),
    /not authoritative transcription evidence/,
  );
});

test("transcription boundary contains no Gemini Live completion heuristic", () => {
  assert.doesNotMatch(source, /inputTranscription|turnComplete|generationComplete|activityEnd/);
  assert.doesNotMatch(source, /setTimeout\s*\(|\bsleep\s*\(/);
});
