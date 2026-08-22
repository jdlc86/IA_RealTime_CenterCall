import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("v33 high-confidence cybersecurity close is committed through lifecycle authority", async () => {
  const v33 = await source("call-session-v33.ts");
  assert.match(v33, /conversationLifecyclePortFor/);
  assert.match(v33, /confirmEndCall\(\s*"cybersecurity_high_confidence_v33"/s);
  assert.match(v33, /lifecycle_authority: "conversation_lifecycle_port"/);
  assert.doesNotMatch(v33, /\.beginClosing/);
  assert.doesNotMatch(v33, /state === "closing"/);
  assert.doesNotMatch(v33, /hangupStarted/);
});

test("v34 blocked-phrase close is committed through lifecycle authority", async () => {
  const v34 = await source("call-session-v34.ts");
  assert.match(v34, /conversationLifecyclePortFor/);
  assert.match(v34, /confirmEndCall\(\s*"blocked_security_phrase_v34"/s);
  assert.doesNotMatch(v34, /\.beginClosing/);
  assert.doesNotMatch(v34, /state !== "closing"/);
  assert.doesNotMatch(v34, /hangupStarted/);
});
