import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createAuthoritativeCallerTranscriptionPort } from "../.test-dist/authoritative-caller-transcription-port.js";
import { GeminiAuthorizedBargeInCommitAdapter } from "../.test-dist/gemini-authorized-barge-in-commit-adapter.js";
import { GeminiDeferredBargeInCandidateOwner } from "../.test-dist/gemini-deferred-barge-in-candidate-owner.js";

const source = readFileSync(new URL("./gemini-authorized-barge-in-commit-adapter.ts", import.meta.url), "utf8");

function host({ failOn = null } = {}) {
  const sent = [];
  return {
    sent,
    send(message) {
      if (failOn && failOn(message)) throw new Error("wire failed");
      sent.push(message);
    },
  };
}

function interruptingSetup() {
  return {
    model: "models/gemini-live-test",
    manualActivityDetection: true,
    manualActivityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  };
}

async function confirmedCandidate(payloads = [Buffer.from([0x00, 0x01]).toString("base64")]) {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const started = owner.beginCandidate();
  for (const payload of payloads) owner.bufferTelnyxMedia(payload);
  const port = createAuthoritativeCallerTranscriptionPort({
    async transcribe(input) {
      return { itemId: input.itemId, transcript: "espera un momento" };
    },
  });
  owner.completeCandidate(await port.transcribe(owner.transcriptionRequest()));
  return owner.confirmInterruption(started.itemId);
}

test("authorized commit requires explicit interrupting manual activity bootstrap", () => {
  const h = host();
  assert.throws(
    () => new GeminiAuthorizedBargeInCommitAdapter(h, {
      model: "models/gemini-live-test",
      manualActivityDetection: false,
    }),
    /requires manual activity detection/,
  );
  assert.throws(
    () => new GeminiAuthorizedBargeInCommitAdapter(h, {
      model: "models/gemini-live-test",
      manualActivityDetection: true,
      manualActivityHandling: "NO_INTERRUPTION",
    }),
    /requires START_OF_ACTIVITY_INTERRUPTS/,
  );
  assert.deepEqual(h.sent, []);
});

test("confirmed candidate alone emits activityStart then retained audio then activityEnd", async () => {
  const h = host();
  const adapter = new GeminiAuthorizedBargeInCommitAdapter(h, interruptingSetup());
  const candidate = await confirmedCandidate([
    Buffer.from([0x00, 0x01]).toString("base64"),
    Buffer.from([0x00, 0x02]).toString("base64"),
  ]);

  assert.deepEqual(adapter.commit(candidate), {
    state: "ACTIVE",
    committedCandidates: 1,
    committedChunks: 2,
  });
  assert.deepEqual(h.sent[0], { realtimeInput: { activityStart: {} } });
  assert.equal(h.sent[1].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.deepEqual([...Buffer.from(h.sent[1].realtimeInput.audio.data, "base64")], [0x01, 0x00]);
  assert.equal(h.sent[2].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.deepEqual([...Buffer.from(h.sent[2].realtimeInput.audio.data, "base64")], [0x02, 0x00]);
  assert.deepEqual(h.sent[3], { realtimeInput: { activityEnd: {} } });

  assert.doesNotMatch(source, /clientContent/);
  assert.doesNotMatch(source, /setTimeout\s*\(|\bsleep\s*\(/);
});

test("shape-compatible but unauthorized candidate fails before any provider write", () => {
  const h = host();
  const adapter = new GeminiAuthorizedBargeInCommitAdapter(h, interruptingSetup());
  assert.throws(
    () => adapter.commit({
      itemId: "gemini-candidate-1",
      transcript: "hola",
      mediaPayloads: ["AAE="],
    }),
    /not semantically authorized/,
  );
  assert.deepEqual(h.sent, []);
});

test("same confirmed candidate cannot be committed twice", async () => {
  const h = host();
  const adapter = new GeminiAuthorizedBargeInCommitAdapter(h, interruptingSetup());
  const candidate = await confirmedCandidate();
  adapter.commit(candidate);
  const before = h.sent.length;
  assert.throws(() => adapter.commit(candidate), /already committed/);
  assert.equal(h.sent.length, before);
});

test("wire failure makes partial replay terminal for this adapter instead of retrying duplicate audio", async () => {
  let mediaWrites = 0;
  const h = host({
    failOn(message) {
      if (message.realtimeInput?.audio) {
        mediaWrites += 1;
        return mediaWrites === 1;
      }
      return false;
    },
  });
  const adapter = new GeminiAuthorizedBargeInCommitAdapter(h, interruptingSetup());
  const candidate = await confirmedCandidate();

  assert.throws(() => adapter.commit(candidate), /wire failed/);
  assert.deepEqual(adapter.snapshot(), {
    state: "FAILED",
    committedCandidates: 0,
    committedChunks: 0,
  });
  const before = h.sent.length;
  assert.throws(() => adapter.commit(candidate), /adapter is failed/);
  assert.equal(h.sent.length, before);
});
