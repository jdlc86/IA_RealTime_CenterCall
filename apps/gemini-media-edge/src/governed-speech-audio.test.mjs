import test from "node:test";
import assert from "node:assert/strict";
import { prepareGovernedSpeechAudio } from "./governed-speech-audio.mjs";

test("governed speech audio preserves correlation and validated exact text", async () => {
  const calls = [];
  const result = await prepareGovernedSpeechAudio(async (request) => {
    calls.push(request);
    return {
      text: request.text,
      pcm16le: Buffer.from([1, 2, 3, 4]),
      sampleRateHertz: 16_000,
      encoding: "PCM16_LE",
    };
  }, { responseId: "speech-7", text: "  De acuerdo, no te transfiero.  " });

  assert.deepEqual(calls, [{ text: "De acuerdo, no te transfiero." }]);
  assert.equal(result.responseId, "speech-7");
  assert.equal(result.text, "De acuerdo, no te transfiero.");
  assert.deepEqual([...result.pcm16le], [1, 2, 3, 4]);
});

test("governed speech audio fails closed on unsupported TTS output", async () => {
  const request = { responseId: "speech-7", text: "Hola" };
  await assert.rejects(
    () => prepareGovernedSpeechAudio(async () => ({ pcm16le: Buffer.from([1, 2]), sampleRateHertz: 24_000, encoding: "PCM16_LE" }), request),
    /unsupported sample rate/,
  );
  await assert.rejects(
    () => prepareGovernedSpeechAudio(async () => ({ pcm16le: Buffer.from([1, 2]), sampleRateHertz: 16_000, encoding: "LINEAR16_BE" }), request),
    /unsupported encoding/,
  );
  await assert.rejects(
    () => prepareGovernedSpeechAudio(async () => ({ pcm16le: Buffer.from([1]), sampleRateHertz: 16_000, encoding: "PCM16_LE" }), request),
    /invalid PCM16 audio/,
  );
  await assert.rejects(
    () => prepareGovernedSpeechAudio(async () => null, request),
    /invalid result/,
  );
});

test("governed speech audio validates command before synthesis", async () => {
  let calls = 0;
  const synthesize = async () => { calls += 1; return {}; };
  await assert.rejects(() => prepareGovernedSpeechAudio(synthesize, { responseId: "", text: "Hola" }), /response id is required/);
  await assert.rejects(() => prepareGovernedSpeechAudio(synthesize, { responseId: "speech-7", text: "" }), /text is required/);
  assert.equal(calls, 0);
});
