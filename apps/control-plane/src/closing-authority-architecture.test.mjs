import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

function caseBody(text, caseName, nextCaseName) {
  const start = text.indexOf(`case \"${caseName}\":`);
  const end = text.indexOf(`case \"${nextCaseName}\":`, start + 1);
  assert.ok(start >= 0, `missing ${caseName} case`);
  assert.ok(end > start, `missing ${nextCaseName} case after ${caseName}`);
  return text.slice(start, end);
}

test("closing authority: lifecycle HANGUP executes transport hangup instead of reopening beginClosing", async () => {
  const v18 = await source("call-session-v18.ts");
  const hangupCase = caseBody(v18, "HANGUP", "RESET_IGNORED_COUNT");

  assert.match(hangupCase, /performHangup\?\.\(\"lifecycle_terminal_audio_stopped\"\)/);
  assert.doesNotMatch(hangupCase, /beginClosing/);
  assert.match(hangupCase, /LIFECYCLE_HANGUP_DISPATCHED_V18/);
});

test("closing authority: v22 remains the single transport adapter to HangupController", async () => {
  const v22 = await source("call-session-v22.ts");

  assert.match(v22, /new HangupController\(/);
  assert.match(v22, /private async performHangup\(trigger: string\): Promise<void>/);
  assert.match(v22, /await this\.getHangupControllerV22\(\)\.perform\(trigger\)/);
});
