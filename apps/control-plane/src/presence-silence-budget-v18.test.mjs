import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("presence recovery allows a natural caller thinking pause", async () => {
  const source = await readFile(new URL("./call-session-v18.ts", import.meta.url), "utf8");
  assert.match(source, /FIRST_PRESENCE_CHECK_MS = 20_000/);
  assert.match(source, /MAX_UNANSWERED_WAIT_MS = 45_000/);
  assert.match(source, /presence_check_ms: FIRST_PRESENCE_CHECK_MS/);
  assert.match(source, /silence_close_ms: MAX_UNANSWERED_WAIT_MS/);
});
