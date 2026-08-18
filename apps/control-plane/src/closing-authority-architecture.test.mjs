import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

function caseBody(text, caseName, nextCaseName) {
  const start = text.indexOf(`case \"${caseName}\":`);
  const end = text.indexOf(`case \"${nextCaseName}\":`, start + 1);
  assert.ok(start >= 0, `missing ${caseName} case`);
  assert.ok(end > start, `missing ${nextCaseName} case after ${caseName}`);
  return text.slice(start, end);
}

test("closing authority: confirmed restaurant end-call enters ConversationTurnLifecycle", async () => {
  const v18 = await source("call-session-v18.ts");
  const v23 = await source("call-session-v23.ts");

  assert.match(v18, /protected observeEndCallConfirmedV18\(reason: string\): void/);
  assert.match(v18, /this\.dispatchLifecycleV18\(\{ type: \"end_call\" \}\)/);
  assert.match(v18, /LIFECYCLE_END_CALL_REQUESTED_V18/);
  assert.match(v23, /observeEndCallConfirmedV18/);
  assert.match(v23, /observeEndCall\.call\(this, \"agent_end_confirmed_v23\"\)/);
});

test("closing authority: v23 retains beginClosing only as compatibility fallback", async () => {
  const v23 = await source("call-session-v23.ts");
  const observerIndex = v23.indexOf("observeEndCallConfirmedV18");
  const fallbackIndex = v23.indexOf("beginClosing?.(\"agent_end_confirmed_v23\"");

  assert.ok(observerIndex >= 0, "missing lifecycle observer");
  assert.ok(fallbackIndex > observerIndex, "legacy beginClosing must remain only after lifecycle observer fallback");
});

test("closing authority: v41 caller-resolved close paths enter lifecycle instead of direct closing", async () => {
  const v41 = await source("call-session-v41-closure-guard.ts");

  assert.match(v41, /private commitCloseThroughLifecycleV41\(reason: string, source: string\): void/);
  assert.match(v41, /session\.observeEndCallConfirmedV18\(reason\)/);
  assert.match(v41, /this\.commitCloseThroughLifecycleV41\(\"contextual_close_resolved_v41\", \"caller_declined_more_help_v41\"\)/);
  assert.match(v41, /this\.commitCloseThroughLifecycleV41\(\"agent_end_confirmed_v41\", \"caller_resolved_close_ambiguity_v41\"\)/);
  assert.equal((v41.match(/session\.beginClosing\?\.\(/g) ?? []).length, 1, "v41 may retain only one beginClosing compatibility fallback");
  assert.match(v41, /V41_CLOSE_LIFECYCLE_COMPATIBILITY_FALLBACK/);
});

test("closing authority: terminal audio keeps response kind across metadata-less buffer events", async () => {
  const v18 = await source("call-session-v18.ts");

  assert.match(v18, /assistantSpeechKindsByResponseIdV18 = new Map<string, AssistantSpeechKind>\(\)/);
  assert.match(v18, /ASSISTANT_SPEECH_KIND_CORRELATED_V18/);
  assert.match(v18, /this\.assistantSpeechKindsByResponseIdV18\.get\(event\.responseId\) \?\? event\.kind/);
  assert.match(v18, /this\.releaseAssistantSpeechKindV18\(providerEvent\)/);
});

test("closing authority: lifecycle HANGUP executes transport hangup instead of reopening beginClosing", async () => {
  const v18 = await source("call-session-v18.ts");
  const hangupCase = caseBody(v18, "HANGUP", "RESET_IGNORED_COUNT");

  assert.match(hangupCase, /performHangup\?\.\(\"lifecycle_terminal_audio_stopped\"\)/);
  assert.doesNotMatch(hangupCase, /beginClosing/);
  assert.match(hangupCase, /LIFECYCLE_HANGUP_DISPATCHED_V18/);
});

test("closing authority: v22 keeps HangupController as the sole transport executor", async () => {
  const v22 = await source("call-session-v22.ts");

  assert.match(v22, /new HangupController\(/);
  assert.match(v22, /private async performHangup\(trigger: string\): Promise<void>/);
  assert.match(v22, /await this\.getHangupControllerV22\(\)\.perform\(trigger\)/);
});

test("closing authority: legacy audio-stop hangup is superseded after lifecycle reaches CLOSING", async () => {
  const v22 = await source("call-session-v22.ts");

  assert.match(v22, /snapshotTurnLifecycleV18\?\.\(\)\?\.state/);
  assert.match(v22, /trigger === \"output_audio_buffer_stopped\" && lifecycleState === \"CLOSING\"/);
  assert.match(v22, /LEGACY_AUDIO_STOP_HANGUP_SUPERSEDED_V22/);
});

test("closing authority: v2 legacy audio-stop path remains only as compatibility and safety fallback", async () => {
  const v2 = await source("call-session-v2.ts");

  assert.match(v2, /performHangup\(\"output_audio_buffer_stopped\"\)/);
  assert.match(v2, /armHangupAfterCurrentAudio/);
});
