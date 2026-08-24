import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("deterministic inherited speech callsites provide product-owned exact text", async () => {
  const [v18, v40, v41] = await Promise.all([
    source("call-session-v18.ts"),
    source("call-session-v40-rebuild.ts"),
    source("call-session-v41-closure-guard.ts"),
  ]);

  assert.match(v18, /exactText: IGNORED_INPUT_RECOVERY_MESSAGE/);
  assert.match(v40, /exactText: PROVIDER_CLEAR_LIVENESS_MESSAGE/);
  assert.match(v41, /exactText: COURTESY_FOLLOWUP_EXACT_TEXT/);
  assert.doesNotMatch(v40, /resume_assistant/);
});
