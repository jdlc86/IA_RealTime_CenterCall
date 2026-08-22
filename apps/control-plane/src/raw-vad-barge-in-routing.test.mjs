import test from "node:test";
import assert from "node:assert/strict";
import { decideRawVadRoute } from "../.test-dist/raw-vad-barge-in-routing.js";

test("provider-neutral caller speech during assistant playback is owned only by v40", () => {
  assert.equal(decideRawVadRoute("CALLER_SPEECH_STARTED", true), "V40_ONLY");
});

test("provider-neutral caller speech outside assistant playback keeps inherited routing", () => {
  assert.equal(decideRawVadRoute("CALLER_SPEECH_STARTED", false), "INHERITED");
});

test("non-VAD provider events keep inherited routing during playback", () => {
  assert.equal(decideRawVadRoute("CALLER_TRANSCRIPT_COMPLETED", true), "INHERITED");
});
