import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

test("Gate B keeps V40 behind the provider-neutral runtime boundary", async () => {
  const text = await source("call-session-v40-rebuild.ts");
  assert.match(text, /realtime-provider-runtime/);
  assert.match(text, /adaptRealtimeProviderEvents/);
  assert.doesNotMatch(text, /openai-realtime-command-adapter/);
  assert.doesNotMatch(text, /input_audio_buffer\./);
  assert.doesNotMatch(text, /output_audio_buffer\./);
  assert.doesNotMatch(text, /response\.created/);
  assert.doesNotMatch(text, /response\.output_text\.done/);
});

test("Gate B keeps V44 raw-VAD routing provider-neutral", async () => {
  const text = await source("call-session-v44-raw-vad-routing.ts");
  assert.match(text, /adaptRealtimeProviderEvents/);
  assert.doesNotMatch(text, /input_audio_buffer\./);
  assert.doesNotMatch(text, /output_audio_buffer\./);
  assert.doesNotMatch(text, /response\.created/);
});

test("split barge-in ordering defers response creation to the newest speech item without timers", async () => {
  const v40 = await source("call-session-v40-rebuild.ts");
  assert.match(v40, /decideConfirmedBargeInPromotion/);
  assert.match(v40, /BARGE_IN_CONFIRMED_DEFERRED_TO_NEWER_SPEECH_V40_REBUILD/);
  assert.match(v40, /BARGE_IN_NEWER_FRAGMENT_TRANSCRIPT_FORWARDED_V40_REBUILD/);
  assert.match(v40, /input_item_deleted: false/);
  assert.doesNotMatch(v40, /setTimeout\s*\(/);
  assert.doesNotMatch(v40, /\bsleep\s*\(/);
});

test("V44 preserves V29 per-item bookkeeping when raw VAD is suppressed", async () => {
  const v44 = await source("call-session-v44-raw-vad-routing.ts");
  const v29 = await source("call-session-v29.ts");
  assert.match(v44, /beginSemanticTurnFromAcousticEvidenceV29/);
  assert.match(v29, /SEMANTIC_TURN_BOOKKEEPING_RESET_FROM_ACOUSTIC_EVIDENCE_V29/);
  assert.match(v29, /semantic_authority_acquired: false/);
  assert.match(v29, /transcript_still_required: true/);
});
