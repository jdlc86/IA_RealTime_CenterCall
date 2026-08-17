import test from "node:test";
import assert from "node:assert/strict";
import { reduceBargeInPlaybackWindow } from "../.test-dist/barge-in-playback-window.js";

test("response.created alone never opens barge-in eligibility", () => {
  let open = false;
  open = reduceBargeInPlaybackWindow(open, { type: "response_created" });
  assert.equal(open, false);
});

test("normal playback opens barge-in and playback stop closes it", () => {
  let open = false;
  open = reduceBargeInPlaybackWindow(open, { type: "response_created" });
  open = reduceBargeInPlaybackWindow(open, { type: "playback_started", protectedSpeech: false });
  assert.equal(open, true);
  open = reduceBargeInPlaybackWindow(open, { type: "playback_stopped" });
  assert.equal(open, false);
});

test("protected playback never opens barge-in", () => {
  const open = reduceBargeInPlaybackWindow(false, { type: "playback_started", protectedSpeech: true });
  assert.equal(open, false);
});
