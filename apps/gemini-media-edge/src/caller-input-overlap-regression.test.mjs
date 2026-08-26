import test from "node:test";
import assert from "node:assert/strict";
import { AuthoritativeCallerInputOwner } from "./caller-input.mjs";

function frame(sample, samples = 320) {
  const bytes = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 2) {
    bytes.writeInt16LE(sample, index * 2);
    if (index + 1 < samples) bytes.writeInt16LE(sample, (index + 1) * 2);
  }
  return bytes.toString("base64");
}

const voiced = frame(12_000);
const silence = frame(0);
const config = { startRms: 0.2, stopRms: 0.05, minSpeechMs: 40, minSilenceMs: 40 };

async function completeCandidate(owner) {
  await owner.observe(voiced);
  const started = await owner.observe(voiced);
  await owner.observe(silence);
  const completed = await owner.observe(silence);
  return { started, completed };
}

test("completed caller fragment stays resolvable while the next fragment starts", async () => {
  const requests = [];
  const owner = new AuthoritativeCallerInputOwner(async (request) => {
    requests.push(request);
    return { itemId: request.itemId, transcript: request.itemId === "gemini-candidate-1" ? "fecha" : "hora y personas" };
  }, config);

  const first = await completeCandidate(owner);
  assert.equal(first.completed.events[1].itemId, "gemini-candidate-1");
  assert.equal(owner.snapshot().transcriptReady, true);

  assert.deepEqual((await owner.observe(voiced)).events, []);
  const secondStarted = await owner.observe(voiced);
  assert.deepEqual(secondStarted.events, [{
    type: "CALLER_SPEECH_STARTED",
    itemId: "gemini-candidate-2",
    playbackResponseIdAtStart: null,
  }]);
  assert.equal(owner.snapshot().activeItemId, "gemini-candidate-2");
  assert.equal(owner.snapshot().pendingCompletedCount, 1);

  const firstResolved = owner.resolve("gemini-candidate-1", "NORMAL");
  assert.equal(firstResolved.transcript, "fecha");
  assert.equal(owner.snapshot().activeItemId, "gemini-candidate-2");
  assert.equal(owner.snapshot().pendingCompletedCount, 0);

  await owner.observe(silence);
  const secondCompleted = await owner.observe(silence);
  assert.equal(secondCompleted.events[1].itemId, "gemini-candidate-2");
  const secondResolved = owner.resolve("gemini-candidate-2", "NORMAL");
  assert.equal(secondResolved.transcript, "hora y personas");
  assert.equal(owner.snapshot().activeItemId, null);
  assert.equal(requests.length, 2);
});

test("resolving a completed fragment does not erase a provisional next-speech onset", async () => {
  const requests = [];
  const owner = new AuthoritativeCallerInputOwner(async (request) => {
    requests.push(request);
    return { itemId: request.itemId, transcript: `fragment-${request.itemId}` };
  }, config);

  await completeCandidate(owner);

  const onset = await owner.observe(voiced, "response-at-arrival");
  assert.deepEqual(onset.events, []);
  assert.ok(owner.snapshot().provisionalPlaybackResponseId !== null);

  const firstResolved = owner.resolve("gemini-candidate-1", "NORMAL");
  assert.equal(firstResolved.itemId, "gemini-candidate-1");

  const secondStarted = await owner.observe(voiced, null);
  assert.equal(secondStarted.events[0].itemId, "gemini-candidate-2");
  assert.equal(secondStarted.events[0].playbackResponseIdAtStart, "response-at-arrival");

  await owner.observe(silence);
  await owner.observe(silence);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].payloads.length, 4);
});
