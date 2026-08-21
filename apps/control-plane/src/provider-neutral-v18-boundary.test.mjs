import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const v18 = readFileSync(new URL("./call-session-v18.ts", import.meta.url), "utf8");

test("V18 lifecycle consumes provider-neutral realtime boundaries", () => {
  assert.match(v18, /realtime-provider-runtime\.js/);
  assert.match(v18, /adaptRealtimeProviderEvents\(data\)/);
  assert.match(v18, /realtimeCommandPortFor\(this as any\)/);
  assert.match(v18, /adaptRealtimeTurnEvent\(providerEvent\)/);
  assert.doesNotMatch(v18, /openai-realtime-event-adapter/);
  assert.doesNotMatch(v18, /openai-realtime-command-adapter/);
  assert.doesNotMatch(v18, /adaptOpenAIRealtimeEvent/);
});

test("V18 presence recovery derives terminality from its lifecycle owner", () => {
  assert.match(v18, /const lifecycleState = this\.turnLifecycleV18\.snapshot\(\)\.state/);
  assert.match(v18, /lifecycleState === "TERMINAL_SPEAKING"/);
  assert.match(v18, /lifecycleState === "HANDOFF"/);
  assert.match(v18, /lifecycleState === "CLOSING"/);
  assert.doesNotMatch(v18, /\bhangupStarted\b/);
  assert.doesNotMatch(v18, /\(this as any\)\.state === "closing"/);
});
