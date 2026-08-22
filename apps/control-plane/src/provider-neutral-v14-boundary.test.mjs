import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const v14 = readFileSync(new URL("./call-session-v14.ts", import.meta.url), "utf8");

test("V14 classifier gate consumes provider-neutral realtime boundaries", () => {
  assert.match(v14, /adaptRealtimeProviderEvents\(data\)/);
  assert.match(v14, /event\.type === "CALLER_SPEECH_STARTED"/);
  assert.match(v14, /event\.type === "SEMANTIC_TOOL_SELECTED"/);
  assert.match(v14, /realtimeCommandPortFor\(this as any\)\.submitToolResult\(/);
  assert.match(v14, /reason:\s*"NO_USER_TURN"/);

  assert.doesNotMatch(v14, /openai-realtime-(?:event|command)-adapter/);
  assert.doesNotMatch(v14, /input_audio_buffer\.speech_started/);
  assert.doesNotMatch(v14, /response\.function_call_arguments\.done/);
  assert.doesNotMatch(v14, /conversation\.item\.create/);
  assert.doesNotMatch(v14, /function_call_output/);
  assert.doesNotMatch(v14, /\b(?:readRealtimeText|TextDecoder|JSON\.parse)\b/);
  assert.doesNotMatch(v14, /\(this as any\)\.send\s*\(/);
});

test("V14 keeps one-shot classifier authority local while delegating wire translation", () => {
  assert.match(v14, /classifierTurnGateV14:\s*ClassifierTurnGateState/);
  assert.match(v14, /armClassifierTurn\(this\.classifierTurnGateV14\)/);
  assert.match(v14, /consumeClassifierTurn\(this\.classifierTurnGateV14\)/);
  assert.match(v14, /this\.classifierTurnGateV14 = decision\.next/);
  assert.match(v14, /if \(!decision\.allowed\)/);
  assert.match(v14, /CORE_INTENT_IGNORED_NO_USER_TURN/);
  assert.match(v14, /CORE_USER_TURN_CLASSIFIER_CONSUMED/);
});
