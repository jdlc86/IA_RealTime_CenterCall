import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("V55 defers governed post-tool speech until the matching active response has completed", () => {
  const runtime = readFileSync(new URL("./realtime-provider-runtime.ts", import.meta.url), "utf8");
  const v55 = readFileSync(new URL("./call-session-v55-governed-speech-liveness.ts", import.meta.url), "utf8");
  const index = readFileSync(new URL("./index-v6.ts", import.meta.url), "utf8");

  assert.match(runtime, /activeAssistantResponseId/);
  assert.match(runtime, /deferredDefaultResponseReplacement/);
  assert.match(runtime, /if \(this\.activeAssistantResponseId !== undefined\)/);
  assert.match(runtime, /responseId !== activeResponseId/);
  assert.match(runtime, /observeAssistantResponseCompleted\(responseId\?: string\)/);
  assert.match(runtime, /if \(deferred\) this\.delegate\.speak\(deferred\)/);

  assert.match(v55, /ASSISTANT_RESPONSE_STARTED/);
  assert.match(v55, /started\.responseId/);
  assert.match(v55, /await BasePrototype\.handleRealtimeMessage\.call\(this, data\)/);
  assert.match(v55, /completed\.responseId/);
  assert.match(v55, /observeRealtimeAssistantResponseCompleted/);
  assert.match(v55, /GOVERNED_POST_TOOL_SPEECH_RELEASE_BOUNDARY_V55/);
  assert.match(v55, /response_scoped_release: true/);
  assert.doesNotMatch(v55, /setTimeout|sleep\s*\(|delay\s*\(/);

  assert.match(index, /call-session-v55-governed-speech-liveness/);
});
