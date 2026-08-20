import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("runtime routes through V54 close-confirmation authority", async () => {
  const index = await source("index-v6.ts");
  assert.match(index, /call-session-v54-close-confirmation-authority/);
});

test("pending close is consumed only by an explicit effective caller turn yes or no", async () => {
  const v54 = await source("call-session-v54-close-confirmation-authority.ts");
  assert.match(v54, /closingConfirmationPendingV41 === true/);
  assert.match(v54, /effectiveCallerTurn/);
  assert.match(v54, /isExplicitClosingConfirmation\(effectiveCallerTurn\)/);
  assert.match(v54, /isExplicitClosingRejection\(effectiveCallerTurn\)/);
  assert.match(v54, /CALLER_TURN_CONSOLIDATED_V54/);
  assert.match(v54, /commitCloseThroughLifecycleV41/);
  assert.match(v54, /CLOSE_CONFIRMATION_AUTHORITY_CONSUMED_V54/);
});

test("ambiguous caller reply preserves pending close and cannot fall into generic semantic tools", async () => {
  const v54 = await source("call-session-v54-close-confirmation-authority.ts");
  assert.match(v54, /CLOSE_CONFIRMATION_AMBIGUOUS_PRESERVED_V54/);
  assert.match(v54, /pending_close: true/);
  assert.match(v54, /generic_semantic_pipeline_bypassed: true/);
  assert.match(v54, /No he entendido si quieres terminar la llamada\. ¿Sí o no\?/);
  assert.match(v54, /tools: "DISABLED"/);
  assert.doesNotMatch(v54, /setTimeout|sleep\s*\(/);
});
