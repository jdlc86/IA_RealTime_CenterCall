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
  assert.match(v23, /conversationLifecyclePortFor\(this\)\.confirmEndCall\(\"agent_end_confirmed_v23\", \"lucia_agent_tool_v23\"\)/);
});

test("closing authority: v23 cannot bypass the neutral lifecycle port", async () => {
  const v23 = await source("call-session-v23.ts");
  assert.doesNotMatch(v23, /observeEndCallConfirmedV18/);
  assert.doesNotMatch(v23, /beginClosing/);
});

test("closing authority: v41 caller-resolved close paths enter the neutral lifecycle port instead of historical session methods", async () => {
  const v41 = await source("call-session-v41-closure-guard.ts");

  assert.match(v41, /private commitCloseV41\(reason: string, source: string\): void/);
  assert.match(v41, /conversationLifecyclePortFor\(this\)\.confirmEndCall\(reason, source\)/);
  assert.match(v41, /this\.commitCloseV41\(\"contextual_close_resolved_v41\", \"caller_declined_more_help_v41\"\)/);
  assert.match(v41, /this\.commitCloseV41\(\"contextual_close_semantic_resolution_v41\", \"lucia_confirmed_contextual_end_call_v41\"\)/);
  assert.match(v41, /closingSessionRuntimeFor\(this\)/);
  assert.doesNotMatch(v41, /observeEndCallConfirmedV18/);
  assert.doesNotMatch(v41, /beginClosing\?\.\(/);
  assert.doesNotMatch(v41, /commitCloseThroughLifecycleV41/);
});

test("closing authority: pending-close continue resolution is atomic through V54 and ClosingSessionRuntime", async () => {
  const v41 = await source("call-session-v41-closure-guard.ts");
  const v54 = await source("call-session-v54-close-confirmation-authority.ts");

  assert.match(v41, /closing\.setConfirmationPending\(true\)/);
  assert.match(v54, /if \(effectiveCallerTurn && closing\.isConfirmationPending\(\)\)/);
  assert.match(v54, /isExplicitClosingRejection\(effectiveCallerTurn\)/);
  assert.match(v54, /closing\.setConfirmationPending\(false\)/);
  assert.match(v54, /closing\.setControllerAssessment\(\{ courtesy: false, closeIntent: \"CONTINUE\" \}\)/);
  assert.match(v54, /caller_resolution: \"CONTINUE\"/);
  assert.match(v54, /generic_semantic_pipeline_preserved: true/);
  assert.match(v54, /finally \{ turnContext\.clear\(\); \}/);
  assert.doesNotMatch(v54, /closingConfirmationPendingV41/);
  assert.doesNotMatch(v54, /controllerCloseAssessmentV41/);
});

test("closing authority: terminal audio keeps response kind across metadata-less buffer events", async () => {
  const v18 = await source("call-session-v18.ts");

  assert.match(v18, /assistantSpeechKindsByResponseIdV18 = new Map<string, AssistantSpeechKind>\(\)/);
  assert.match(v18, /ASSISTANT_SPEECH_KIND_CORRELATED_V18/);
  assert.match(v18, /this\.assistantSpeechKindsByResponseIdV18\.get\(event\.responseId\) \?\? event\.kind/);
  assert.match(v18, /this\.releaseAssistantSpeechKindV18\(providerEvent\)/);
});

test("closing authority: terminal playback ownership does not require provider response id", async () => {
  const v18 = await source("call-session-v18.ts");

  assert.match(v18, /terminalPlaybackPendingV18 = false/);
  assert.match(v18, /terminalPlaybackActiveV18 = false/);
  assert.match(v18, /this\.terminalPlaybackPendingV18 = true/);
  assert.match(v18, /LIFECYCLE_TERMINAL_PLAYBACK_BOUND_V18/);
  assert.match(v18, /provider_response_id_required: false/);
  assert.match(v18, /event\.type === \"ASSISTANT_AUDIO_STOPPED\" && this\.terminalPlaybackActiveV18/);
  assert.match(v18, /authoritative_kind: \"TERMINAL\"/);
});

test("closing authority: lifecycle HANGUP drains terminal transport before executing hangup", async () => {
  const v18 = await source("call-session-v18.ts");
  const hangupCase = caseBody(v18, "HANGUP", "RESET_IGNORED_COUNT");

  assert.match(hangupCase, /LIFECYCLE_TERMINAL_DRAIN_ARMED_V18/);
  assert.match(hangupCase, /normal_response_latency_affected: false/);
  assert.match(hangupCase, /performHangup\?\.\(\"lifecycle_terminal_transport_drained\"\)/);
  assert.doesNotMatch(hangupCase, /performHangup\?\.\(\"lifecycle_terminal_audio_stopped\"\)/);
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

  assert.match(v22, /conversationLifecyclePortFor\(this\)\.isClosing\(\)/);
  assert.match(v22, /trigger === \"output_audio_buffer_stopped\" && conversationLifecyclePortFor\(this\)\.isClosing\(\)/);
  assert.doesNotMatch(v22, /snapshotTurnLifecycleV18/);
  assert.match(v22, /LEGACY_AUDIO_STOP_HANGUP_SUPERSEDED_V22/);
});

test("closing authority: v2 legacy audio-stop path remains only as compatibility and safety fallback", async () => {
  const v2 = await source("call-session-v2.ts");

  assert.match(v2, /performHangup\(\"output_audio_buffer_stopped\"\)/);
  assert.match(v2, /armHangupAfterCurrentAudio/);
});
