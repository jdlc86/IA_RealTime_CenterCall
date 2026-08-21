import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = async (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8");

test("hangup controller routes provider-neutral termination while preserving source-leg authority", async () => {
  const controller = await source("hangup-controller.ts");
  const v22 = await source("call-session-v22.ts");

  assert.match(controller, /getSourceCallControlId\?\(\): string \| null/);
  assert.match(controller, /terminateCall\(request: CallTerminationRequest\): Promise<CallTerminationResult>/);
  assert.match(controller, /fallbackMode:\s*"SOURCE_ONLY"/);
  assert.match(controller, /fallbackMode:\s*"REALTIME_FALLBACK"/);
  assert.match(controller, /this\.host\.terminateCall\(request\)/);
  assert.match(controller, /completion_claimed:\s*false/);
  assert.match(controller, /confirmation_source:\s*"sideband_close"/);

  assert.doesNotMatch(controller, /\b(?:TELNYX_API_KEY|OPENAI_API_KEY)\b/);
  assert.doesNotMatch(controller, /api\.(?:telnyx|openai)\.com/);
  assert.doesNotMatch(controller, /\bfetch\s*\(/);

  assert.match(v22, /callTerminationPortFor\(session\)/);
  assert.match(v22, /terminateCall:\s*\(request\)\s*=>\s*terminationPort\.terminate\(request\)/);
  assert.match(v22, /humanHandoffTransportRuntimeFor\(this\)\.transportContext\(\)\.sourceCallControlId/);
  assert.match(v22, /conversationLifecyclePortFor\(this\)\.isClosing\(\)/);

  assert.doesNotMatch(v22, /\b(?:getTelnyxApiKey|TELNYX_API_KEY|OPENAI_API_KEY)\b/);
  assert.doesNotMatch(v22, /api\.(?:telnyx|openai)\.com/);
  assert.doesNotMatch(v22, /telnyxCallControlIdV37/);
  assert.doesNotMatch(v22, /snapshotTurnLifecycleV18/);
});
