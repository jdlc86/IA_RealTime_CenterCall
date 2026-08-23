import assert from "node:assert/strict";
import test from "node:test";
import { GeminiLiveCallerActivityOwner } from "../.test-dist/gemini-live-caller-activity-owner.js";

test("manual Gemini caller activity creates stable neutral item identity", () => {
  const owner = new GeminiLiveCallerActivityOwner();
  const first = owner.begin();
  assert.deepEqual(first.event, { type: "CALLER_SPEECH_STARTED", itemId: "gemini-caller-1" });
  assert.equal(first.snapshot.activeItemId, "gemini-caller-1");

  const stopped = owner.end();
  assert.deepEqual(stopped.event, { type: "CALLER_SPEECH_STOPPED" });
  assert.equal(stopped.itemId, "gemini-caller-1");
  assert.equal(stopped.snapshot.activeItemId, null);

  const second = owner.begin();
  assert.equal(second.event.itemId, "gemini-caller-2");
});

test("caller activity owner fails closed on overlapping or unmatched boundaries", () => {
  const owner = new GeminiLiveCallerActivityOwner();
  assert.throws(() => owner.end(), /cannot end without an active item/);
  owner.begin();
  assert.throws(() => owner.begin(), /already active/);
});

test("caller activity boundary never fabricates transcript completion", () => {
  const owner = new GeminiLiveCallerActivityOwner();
  const events = [owner.begin().event, owner.end().event];
  assert.equal(events.some((event) => event.type === "CALLER_TRANSCRIPT_COMPLETED"), false);
});
