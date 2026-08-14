import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./call-session-v18.ts", import.meta.url), "utf8");

test("VAD alone never resets inactivity", () => {
  assert.match(source, /USER_AUDIO_DETECTED_NO_RESET/);
  assert.match(source, /vad_is_not_semantic_evidence/);
  assert.doesNotMatch(source, /speech_started[\s\S]{0,300}armWaitingForUserV18/);
});

test("watchdog has staged recovery and hard unanswered limit", () => {
  assert.match(source, /FIRST_PRESENCE_CHECK_MS = 8_000/);
  assert.match(source, /SECOND_PRESENCE_CHECK_MS = 16_000/);
  assert.match(source, /MAX_UNANSWERED_WAIT_MS = 26_000/);
  assert.match(source, /¿Sigues ahí\?/);
  assert.match(source, /¿Me escuchas\?/);
  assert.match(source, /user_inactivity_timeout/);
});

test("tool execution suspends relative watchdog but max call duration remains", () => {
  assert.match(source, /USER_TURN_WATCHDOG_SUSPENDED_FOR_TOOL/);
  assert.match(source, /MAX_CALL_DURATION_MS = 15 \* 60_000/);
  assert.match(source, /max_call_duration_reached/);
});

test("Lucia semantic reaction validates the user turn", () => {
  assert.match(source, /USER_TURN_VALIDATED_BY_LUCIA/);
  assert.match(source, /agent_tool/);
  assert.match(source, /lucia_spoken_response/);
});
