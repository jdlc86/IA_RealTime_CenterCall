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

test("V44 preserves per-item semantic bookkeeping through the neutral coordinator when raw VAD is suppressed", async () => {
  const v44 = await source("call-session-v44-raw-vad-routing.ts");
  const coordinator = await source("semantic-turn-coordinator.ts");
  assert.match(v44, /beginSemanticTurnFromAcousticEvidence/);
  assert.match(v44, /semantic-turn-coordinator/);
  assert.doesNotMatch(v44, /beginSemanticTurnFromAcousticEvidenceV29/);
  assert.match(coordinator, /SEMANTIC_TURN_BOOKKEEPING_RESET_FROM_ACOUSTIC_EVIDENCE_V29/);
  assert.match(coordinator, /semantic_authority_acquired: false/);
  assert.match(coordinator, /transcript_still_required: true/);
  assert.match(coordinator, /owner: "semantic_turn_runtime"/);
});

test("provider-cleared false barge-in cannot strand the call in dead air", async () => {
  const v40 = await source("call-session-v40-rebuild.ts");
  assert.match(v40, /decideIgnoredBargeInPlaybackRecovery/);
  assert.match(v40, /providerClearedPlaybackBeforeDecisionV40/);
  assert.match(v40, /BARGE_IN_PROVIDER_CLEAR_BEFORE_DECISION_V40_REBUILD/);
  assert.match(v40, /BARGE_IN_PROVIDER_CLEAR_LIVENESS_RECOVERY_V40_REBUILD/);
  assert.match(v40, /RECOVER_LIVENESS/);
  assert.doesNotMatch(v40, /setTimeout\s*\(/);
  assert.doesNotMatch(v40, /\bsleep\s*\(/);
});
