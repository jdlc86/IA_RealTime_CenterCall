import test from "node:test";
import assert from "node:assert/strict";
import { decideRawVadRoute } from "../.test-dist/raw-vad-barge-in-routing.js";

test("speech_started during assistant playback is owned only by v40", () => {
  assert.equal(decideRawVadRoute("input_audio_buffer.speech_started", true), "V40_ONLY");
});

test("speech_started outside assistant playback keeps inherited routing", () => {
  assert.equal(decideRawVadRoute("input_audio_buffer.speech_started", false), "INHERITED");
});

test("non-VAD events keep inherited routing during playback", () => {
  assert.equal(decideRawVadRoute("conversation.item.input_audio_transcription.completed", true), "INHERITED");
});
