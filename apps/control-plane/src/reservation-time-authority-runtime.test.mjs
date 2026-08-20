import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("V53 blocks unproven reservation time before availability or write and remains silent", async () => {
  const source = await readFile(new URL("./call-session-v53-reservation-time-authority.ts", import.meta.url), "utf8");
  assert.match(source, /RESERVATION_TIME_ASSUMPTION_BLOCKED_V53/);
  assert.match(source, /availability_checked: false/);
  assert.match(source, /reservation_write_attempted: false/);
  assert.match(source, /submitToolResult/);
  assert.match(source, /speech_owner: "direct_agent_runtime_v26"/);
  const start = source.indexOf("private rejectUnprovenTimeV53");
  const end = source.indexOf("private createReservationCommittedV53", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /\.speak\s*\(/);
  assert.match(source, /authorizePublicRestaurantToolV29/);
  assert.doesNotMatch(source, /setTimeout|sleep\s*\(/);
});

test("V53 retains CREATE time across contact collection and consumes only after BOOKED reset", async () => {
  const source = await readFile(new URL("./call-session-v53-reservation-time-authority.ts", import.meta.url), "utf8");
  assert.match(source, /authorizedStartsAtV53/);
  assert.match(source, /requestedStartsAt: startsAt/);
  assert.match(source, /createReservationCommittedV53/);
  assert.match(source, /reservationDraftV19/);
  assert.match(source, /RESERVATION_TIME_AUTHORITY_RETAINED_V53/);
  assert.match(source, /reason: "create_not_committed"/);
  assert.match(source, /consumeAuthorizedTimeV53\(toolEvent\.name, "backend_booked_commit"\)/);
  assert.match(source, /delete this\.authorizedStartsAtV53\[tool\]/);

  const confirmStart = source.indexOf("if (args.confirm === true)");
  const createBranchEnd = source.indexOf("} else {", source.indexOf("if (toolEvent.name === CREATE_RESERVATION)", confirmStart));
  assert.ok(confirmStart >= 0 && createBranchEnd > confirmStart);
  const createBranch = source.slice(confirmStart, createBranchEnd);
  assert.match(createBranch, /createReservationCommittedV53\(\)/);
  assert.doesNotMatch(createBranch, /delete this\.authorizedStartsAtV53/);
});
