import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./call-session-v29.ts", import.meta.url), "utf8");

test("v29 treats pre-transcript background ignore as provisional and explicitly retries after usable transcript", () => {
  assert.match(source, /shouldReopenSemanticTurnAfterProvisionalIgnore/);
  assert.match(source, /PROVISIONAL_BACKGROUND_IGNORE_SUPERSEDED_V29/);
  assert.match(source, /PROVISIONAL_BACKGROUND_IGNORE_RETRY_REQUESTED_V29/);

  const retryBoundary = source.indexOf("PROVISIONAL_BACKGROUND_IGNORE_RETRY_REQUESTED_V29");
  const createResponseBeforeBoundary = source.lastIndexOf("createDefaultResponse()", retryBoundary);
  assert.ok(createResponseBeforeBoundary >= 0, "reopened semantic turn must explicitly request a new response");

  assert.match(source, /timer_used:\s*false/);
});

test("v29 preserves one authoritative business tool per caller turn", () => {
  assert.match(source, /selectSemanticTool\(this\.semanticTurnDecisionV29, event\.name\)/);
  assert.match(source, /DUPLICATE_SEMANTIC_TOOL_BLOCKED_V29/);
  assert.match(source, /event\.name === INPUT_IGNORED/);
});
