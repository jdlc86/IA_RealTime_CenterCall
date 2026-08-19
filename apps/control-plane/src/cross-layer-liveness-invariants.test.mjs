import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  beginSemanticCallerTurn,
  selectSemanticTool,
} from "../.test-dist/semantic-turn-decision-policy.js";
import {
  initialMalformedToolCorrectionState,
  observeCallerTurnStarted,
  decideMalformedToolCorrection,
} from "../.test-dist/malformed-tool-correction-policy.js";
import { decideTurnConcurrencyAcquire } from "../.test-dist/turn-concurrency-acquire-policy.js";
import {
  decideIgnoredBargeInPlaybackRecovery,
  decideConfirmedBargeInPromotion,
  decideDeferredBargeInTranscriptRoute,
} from "../.test-dist/barge-in-semantic-authority.js";

function validToolOnce(tool) {
  let semantic = beginSemanticCallerTurn();
  const first = selectSemanticTool(semantic, tool);
  assert.equal(first.allowed, true);
  semantic = first.next;
  const second = selectSemanticTool(semantic, tool);
  assert.equal(second.allowed, false);
  return { businessActions: 1, duplicateBlocked: true };
}

test("cross-layer trace: malformed mutation may be repaired once by the same tool without dead air or double mutation", () => {
  let correction = initialMalformedToolCorrectionState();
  const malformed = decideMalformedToolCorrection(correction, "restaurant_reservation_create", '{"party_size":');
  assert.equal(malformed.action, "PASS_INVALID_WITHOUT_CONSUMING");
  correction = malformed.next;

  const repaired = decideMalformedToolCorrection(correction, "restaurant_reservation_create", '{"party_size":2}');
  assert.equal(repaired.action, "PASS_VALID_CORRECTION_TO_V29");

  const outcome = validToolOnce("restaurant_reservation_create");
  assert.deepEqual(outcome, { businessActions: 1, duplicateBlocked: true });
});

test("cross-layer trace: malformed mutation cannot silently become another business action", () => {
  let correction = initialMalformedToolCorrectionState();
  correction = decideMalformedToolCorrection(correction, "restaurant_reservation_create", '{"party_size":').next;
  const changed = decideMalformedToolCorrection(correction, "restaurant_reservation_cancel", '{"confirm":true}');
  assert.equal(changed.action, "REJECT_CROSS_TOOL_CORRECTION");
  assert.equal(changed.next.pendingMalformedTool, "restaurant_reservation_create");
});

test("cross-layer trace: fresh caller evidence clears malformed affinity and permits a genuinely new intent", () => {
  let correction = initialMalformedToolCorrectionState();
  correction = decideMalformedToolCorrection(correction, "restaurant_reservation_create", '{"party_size":').next;
  correction = observeCallerTurnStarted(correction);
  const nextIntent = decideMalformedToolCorrection(correction, "restaurant_reservation_cancel", '{"confirm":true}');
  assert.equal(nextIntent.action, "PASS_TO_V29");
});

test("cross-layer trace: older split transcript cannot acquire V36 or become the semantic boundary", () => {
  const acquire = decideTurnConcurrencyAcquire({
    usableTranscript: true,
    normalPlaybackActive: false,
    higherLayerOwns: false,
    newerCallerSpeechObserved: true,
  });
  assert.equal(acquire, "BYPASS_NEWER_CALLER_SPEECH");

  assert.equal(decideConfirmedBargeInPromotion("item-A", "item-B"), "DEFER_TO_NEWER_SPEECH");
  assert.equal(decideDeferredBargeInTranscriptRoute("item-B", "item-A", true), "WAIT_FOR_LATEST");
  assert.equal(decideDeferredBargeInTranscriptRoute("item-B", "item-B", true), "PROMOTE_LATEST");
});

test("cross-layer trace: provider-destructive IGNORE has liveness recovery but terminal state remains absorbing", () => {
  assert.equal(decideIgnoredBargeInPlaybackRecovery({
    providerClearedPlaybackBeforeDecision: true,
    terminal: false,
  }), "RECOVER_LIVENESS");
  assert.equal(decideIgnoredBargeInPlaybackRecovery({
    providerClearedPlaybackBeforeDecision: true,
    terminal: true,
  }), "KEEP_SILENT");
});

test("runtime wiring: active entrypoint and critical layers consume the policies exercised above", () => {
  const index = readFileSync(new URL("./index-v6.ts", import.meta.url), "utf8");
  const v51 = readFileSync(new URL("./call-session-v51-malformed-tool-authority.ts", import.meta.url), "utf8");
  const v36 = readFileSync(new URL("./call-session-v36-turn-concurrency.ts", import.meta.url), "utf8");
  const v40 = readFileSync(new URL("./call-session-v40-response-owner-rebuild.ts", import.meta.url), "utf8");

  assert.match(index, /call-session-v51-malformed-tool-authority/);
  assert.match(v51, /decideMalformedToolCorrection/);
  assert.match(v51, /CALLER_TRANSCRIPT_COMPLETED/);
  assert.match(v51, /SEMANTIC_TOOL_CROSS_TOOL_CORRECTION_BLOCKED_V51/);
  assert.match(v51, /tools:\s*"DISABLED"/);
  assert.match(v36, /decideTurnConcurrencyAcquire/);
  assert.match(v36, /TURN_CONCURRENCY_OLDER_SPLIT_FRAGMENT_DEFERRED_V36/);
  assert.match(v40, /decideIgnoredBargeInPlaybackRecovery/);
  assert.doesNotMatch(v51, /setTimeout|sleep\s*\(|delay\s*\(/);
});
