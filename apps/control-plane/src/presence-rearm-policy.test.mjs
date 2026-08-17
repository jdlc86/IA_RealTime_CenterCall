import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRearmPresenceAfterTrigger } from "../.test-dist/presence-rearm-policy.js";

test("ignored background input preserves existing inactivity deadline", () => {
  assert.equal(shouldRearmPresenceAfterTrigger("background_input_ignored_v29"), false);
});

test("normal assistant completion still arms waiting for the user", () => {
  assert.equal(shouldRearmPresenceAfterTrigger("assistant_audio_completed"), true);
});
