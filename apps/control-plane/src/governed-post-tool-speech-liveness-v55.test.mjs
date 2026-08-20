import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("governed post-tool speech liveness is composed without a V55 CallSession layer", () => {
  const runtime = readFileSync(new URL("./realtime-provider-runtime.ts", import.meta.url), "utf8");
  const coordinator = readFileSync(new URL("./governed-speech-liveness-coordinator.ts", import.meta.url), "utf8");
  const v54 = readFileSync(new URL("./call-session-v54-close-confirmation-authority.ts", import.meta.url), "utf8");
  const index = readFileSync(new URL("./index-v6.ts", import.meta.url), "utf8");

  assert.match(runtime, /activeAssistantResponseId/);
  assert.match(runtime, /deferredDefaultResponseReplacement/);
  assert.match(runtime, /if \(this\.activeAssistantResponseId !== undefined\)/);
  assert.match(runtime, /responseId !== activeResponseId/);
  assert.match(runtime, /observeAssistantResponseCompleted\(responseId\?: string\)/);
  assert.match(runtime, /if \(deferred\) this\.delegate\.speak\(deferred\)/);

  assert.match(coordinator, /observeGovernedSpeechBeforeLowerLayers/);
  assert.match(coordinator, /observeRealtimeAssistantResponseStarted/);
  assert.match(coordinator, /observeGovernedSpeechAfterLowerLayers/);
  assert.match(coordinator, /observeRealtimeAssistantResponseCompleted/);
  assert.match(coordinator, /GOVERNED_POST_TOOL_SPEECH_RELEASE_BOUNDARY_V55/);
  assert.match(coordinator, /response_scoped_release: true/);
  assert.match(coordinator, /inheritance_layer_removed: true/);
  assert.doesNotMatch(coordinator, /setTimeout|sleep\s*\(|delay\s*\(/);

  const before = v54.indexOf("observeGovernedSpeechBeforeLowerLayers(session, events)");
  const lower = v54.lastIndexOf("await BasePrototype.handleRealtimeMessage.call(this, data)");
  const after = v54.indexOf("observeGovernedSpeechAfterLowerLayers(session, events)");
  assert.ok(before >= 0 && lower > before && after > lower, "START must be observed before lower layers and COMPLETED after them");

  assert.match(index, /call-session-v54-close-confirmation-authority/);
  assert.doesNotMatch(index, /call-session-v55-governed-speech-liveness/);
});
