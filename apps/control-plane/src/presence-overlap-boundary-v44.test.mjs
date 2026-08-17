import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const v18 = fs.readFileSync(new URL("./call-session-v18.ts", import.meta.url), "utf8");
const v36 = fs.readFileSync(new URL("./call-session-v36.ts", import.meta.url), "utf8");
const v44 = fs.readFileSync(new URL("./call-session-v44-presence-overlap.ts", import.meta.url), "utf8");

test("discarded overlapping semantic turn can refresh presence without becoming a second turn", () => {
  assert.match(v36, /TURN_CONCURRENCY_OVERLAPPING_TURN_DROPPED_V36/);
  assert.match(v36, /this\.onOverlappingTurnDroppedV36\(event\)/);
  assert.match(v44, /hasUsablePresenceTranscript\(event\.transcript\)/);
  assert.match(v44, /refreshRecentUserPresenceV18\?\.\("v36_overlapping_transcript_dropped"\)/);
  assert.match(v44, /semantic_processing_unchanged: true/);
  assert.match(v44, /presence_only: true/);
});

test("presence-only refresh renews watchdog clock but does not validate semantic turn", () => {
  assert.match(v18, /protected refreshRecentUserPresenceV18/);
  assert.match(v18, /USER_PRESENCE_EVIDENCE_REFRESHED_V18/);
  assert.match(v18, /semantic_turn_validated: false/);
  assert.doesNotMatch(v44, /response\.create/);
  assert.doesNotMatch(v44, /restaurant_/);
});
