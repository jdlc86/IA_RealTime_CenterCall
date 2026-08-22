import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("V53 blocks unproven reservation time through the governed post-tool boundary", async () => {
  const source = await readFile(new URL("./call-session-v53-reservation-time-authority.ts", import.meta.url), "utf8");
  assert.match(source, /RESERVATION_TIME_ASSUMPTION_BLOCKED_V53/);
  assert.match(source, /availability_checked: false/);
  assert.match(source, /reservation_write_attempted: false/);
  assert.match(source, /submitToolResult/);
  assert.match(source, /createDefaultResponse/);
  assert.match(source, /speech_owner: "direct_agent_runtime_v26"/);
  const start = source.indexOf("private rejectUnprovenTimeV53");
  const end = source.indexOf("private consumeAuthorizedTimeV53", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /\.speak\s*\(/);
  assert.doesNotMatch(source, /setTimeout|sleep\s*\(/);
});

test("V53 owns no private reservation draft or time state", async () => {
  const source = await readFile(new URL("./call-session-v53-reservation-time-authority.ts", import.meta.url), "utf8");
  assert.match(source, /reservationTimeSessionRuntimeFor/);
  assert.match(source, /reservationSessionRuntimeFor/);
  assert.match(source, /callerTurnContextRuntimeFor/);
  assert.doesNotMatch(source, /authorizedStartsAtV53|awaitingReservationTimeAnswerV53|latestCallerTranscriptV53|reservationDraftV19/);
});

test("V53 consumes CREATE time only after the reservation runtime reports a new commit epoch", async () => {
  const source = await readFile(new URL("./call-session-v53-reservation-time-authority.ts", import.meta.url), "utf8");
  assert.match(source, /commitEpochBefore/);
  assert.match(source, /reservationRuntime\.committedAfter\(commitEpochBefore\)/);
  assert.match(source, /consumeAuthorizedTimeV53\(toolEvent\.name, "backend_booked_commit"\)/);
  assert.match(source, /RESERVATION_TIME_AUTHORITY_RETAINED_V53/);
  assert.match(source, /reason: "create_not_committed"/);
});

test("search results establish backend-offered slot authority without phrase matching", async () => {
  const searchSource = await readFile(new URL("./call-session-v31.ts", import.meta.url), "utf8");
  const authoritySource = await readFile(new URL("./call-session-v53-reservation-time-authority.ts", import.meta.url), "utf8");
  assert.match(searchSource, /recordOfferedSlots\(authorizedRows\.map/);
  assert.match(authoritySource, /matchesOfferedSlotAfterCallerTurn/);
  assert.match(authoritySource, /SEMANTIC_SELECTION_OF_BACKEND_OFFERED_SLOT/);
});
