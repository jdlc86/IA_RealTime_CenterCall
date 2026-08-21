import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  beginSemanticCallerTurn,
  selectSemanticTool,
} from "../.test-dist/semantic-turn-decision-policy.js";
import {
  initialMalformedToolCorrectionState,
  observeMalformedToolRecoveryPlaybackCompleted,
  observeCallerSpeechAfterMalformedRecovery,
  observeCallerTranscriptAfterMalformedRecovery,
  decideMalformedToolCorrection,
} from "../.test-dist/malformed-tool-correction-policy.js";
import { decideTurnConcurrencyAcquire } from "../.test-dist/turn-concurrency-acquire-policy.js";
import {
  decideIgnoredBargeInPlaybackRecovery,
  decideConfirmedBargeInPromotion,
  decideDeferredBargeInTranscriptRoute,
} from "../.test-dist/barge-in-semantic-authority.js";
import { decideDirectPostToolResponse } from "../.test-dist/post-booking-conversation-policy.js";
import { decideReservationDateScope } from "../.test-dist/reservation-date-scope-policy.js";

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
  assert.equal(changed.next.recoveryRequired, true);
});

test("cross-layer trace: split/late transcript cannot reset malformed affinity", () => {
  let correction = initialMalformedToolCorrectionState();
  correction = decideMalformedToolCorrection(correction, "restaurant_reservation_create", '{"party_size":').next;
  correction = decideMalformedToolCorrection(correction, "restaurant_reservation_cancel", '{"confirm":true}').next;

  correction = observeCallerTranscriptAfterMalformedRecovery(correction);
  const stillBlocked = decideMalformedToolCorrection(correction, "restaurant_reservation_cancel", '{"confirm":true}');
  assert.equal(stillBlocked.action, "REJECT_CROSS_TOOL_CORRECTION");
});

test("cross-layer trace: completed recovery plus fresh caller speech/transcript opens a genuinely new intent", () => {
  let correction = initialMalformedToolCorrectionState();
  correction = decideMalformedToolCorrection(correction, "restaurant_reservation_create", '{"party_size":').next;
  correction = decideMalformedToolCorrection(correction, "restaurant_reservation_cancel", '{"confirm":true}').next;
  correction = observeMalformedToolRecoveryPlaybackCompleted(correction);

  correction = observeCallerTranscriptAfterMalformedRecovery(correction);
  assert.equal(correction.pendingMalformedTool, "restaurant_reservation_create");

  correction = observeCallerSpeechAfterMalformedRecovery(correction);
  correction = observeCallerTranscriptAfterMalformedRecovery(correction);
  assert.equal(correction.pendingMalformedTool, null);

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

test("cross-layer trace: reservation missing information yields speech and cannot trigger a second same-turn business tool", () => {
  let semantic = beginSemanticCallerTurn();
  const create = selectSemanticTool(semantic, "restaurant_reservation_create");
  assert.equal(create.allowed, true);
  semantic = create.next;

  const postTool = decideDirectPostToolResponse("restaurant_reservation_create", {
    ok: true,
    status: "MISSING_INFORMATION",
    missing: ["starts_at"],
  });
  assert.equal(postTool.action, "COLLECT");
  assert.equal(postTool.reason, "RESERVATION_MISSING_INFORMATION");
  assert.ok(postTool.exactText.length > 0);
  assert.match(postTool.instructions, /No llames herramientas en esta misma respuesta/);
  assert.match(postTool.instructions, /Espera el siguiente turno del cliente/);

  const sameTurnSearch = selectSemanticTool(semantic, "restaurant_reservation_search");
  assert.equal(sameTurnSearch.allowed, false);
  assert.equal(sameTurnSearch.duplicateOf, "restaurant_reservation_create");
});

test("cross-layer trace: reservation date drift is blocked before a second business mutation and exact later-turn change is allowed", () => {
  const first = decideReservationDateScope({
    activeLocalDate: null,
    requestedLocalDate: "2026-08-26",
    pendingChange: null,
    currentCallerTurnEpoch: 4,
  });
  assert.deepEqual(first, { action: "ALLOW_AND_SET", localDate: "2026-08-26" });

  const drift = decideReservationDateScope({
    activeLocalDate: "2026-08-26",
    requestedLocalDate: "2026-08-25",
    pendingChange: null,
    currentCallerTurnEpoch: 4,
  });
  assert.deepEqual(drift, {
    action: "REQUIRE_CONFIRMATION",
    fromLocalDate: "2026-08-26",
    toLocalDate: "2026-08-25",
  });

  const pendingChange = {
    fromLocalDate: "2026-08-26",
    toLocalDate: "2026-08-25",
    requestedAtCallerTurnEpoch: 4,
  };
  const wrongTarget = decideReservationDateScope({
    activeLocalDate: "2026-08-26",
    requestedLocalDate: "2026-08-24",
    pendingChange,
    currentCallerTurnEpoch: 5,
  });
  assert.equal(wrongTarget.action, "REQUIRE_CONFIRMATION");

  const confirmed = decideReservationDateScope({
    activeLocalDate: "2026-08-26",
    requestedLocalDate: "2026-08-25",
    pendingChange,
    currentCallerTurnEpoch: 5,
  });
  assert.deepEqual(confirmed, { action: "ALLOW_CONFIRMED_CHANGE", localDate: "2026-08-25" });
});

test("cross-layer fuzz: malformed and corrected tool sequences never execute more than one business action per caller intervention", () => {
  const tools = [
    "restaurant_reservation_create",
    "restaurant_reservation_cancel",
    "restaurant_reservation_search",
    "restaurant_business_info",
  ];
  let seed = 0x51c0ffee;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let trace = 0; trace < 1000; trace += 1) {
    let correction = initialMalformedToolCorrectionState();
    let semantic = beginSemanticCallerTurn();
    let businessActions = 0;
    const length = 2 + Math.floor(random() * 8);

    for (let step = 0; step < length; step += 1) {
      const tool = tools[Math.floor(random() * tools.length)];
      const malformed = random() < 0.4;
      const args = malformed ? '{"value":' : JSON.stringify({ value: step + 1 });
      const decision = decideMalformedToolCorrection(correction, tool, args);
      correction = decision.next;

      if (decision.action === "PASS_INVALID_WITHOUT_CONSUMING") continue;
      if (decision.action === "REJECT_CROSS_TOOL_CORRECTION") continue;

      const semanticDecision = selectSemanticTool(semantic, tool);
      semantic = semanticDecision.next;
      if (semanticDecision.allowed) businessActions += 1;
    }

    assert.ok(businessActions <= 1, `trace ${trace} executed ${businessActions} business actions`);
  }
});

test("runtime wiring: invalid and rejected tool paths both preserve an explicit liveness route", () => {
  const v25 = readFileSync(new URL("./call-session-v25.ts", import.meta.url), "utf8");
  const v51 = readFileSync(new URL("./call-session-v51-malformed-tool-authority.ts", import.meta.url), "utf8");
  const malformedToolCorrectionRuntime = readFileSync(new URL("./malformed-tool-correction-runtime.ts", import.meta.url), "utf8");
  assert.match(v25, /PUBLIC_TOOL_AUTHORIZATION_INVALID_ARGUMENTS_V25/);
  assert.match(v25, /port\.submitToolResult/);
  assert.match(v25, /port\.createDefaultResponse\(\)/);
  assert.match(v51, /malformedToolCorrectionRuntimeFor/);
  assert.match(v51, /runtime\.observe\(this, event\)/);
  assert.match(malformedToolCorrectionRuntime, /SEMANTIC_TOOL_CROSS_TOOL_CORRECTION_BLOCKED_V51/);
  assert.match(malformedToolCorrectionRuntime, /port\.speak\(/);
  assert.match(malformedToolCorrectionRuntime, /tools:\s*"DISABLED"/);
});

test("runtime wiring: active entrypoint and critical layers consume the policies exercised above", () => {
  const index = readFileSync(new URL("./index-v6.ts", import.meta.url), "utf8");
  const v54 = readFileSync(new URL("./call-session-v54-close-confirmation-authority.ts", import.meta.url), "utf8");
  const v53 = readFileSync(new URL("./call-session-v53-reservation-time-authority.ts", import.meta.url), "utf8");
  const v52 = readFileSync(new URL("./call-session-v52-trusted-reservation-contact.ts", import.meta.url), "utf8");
  const v51 = readFileSync(new URL("./call-session-v51-malformed-tool-authority.ts", import.meta.url), "utf8");
  const malformedToolCorrectionRuntime = readFileSync(new URL("./malformed-tool-correction-runtime.ts", import.meta.url), "utf8");
  const v36 = readFileSync(new URL("./call-session-v36.ts", import.meta.url), "utf8");
  const turnConcurrencyCoordinator = readFileSync(new URL("./turn-concurrency-coordinator.ts", import.meta.url), "utf8");
  const v40 = readFileSync(new URL("./call-session-v40-rebuild.ts", import.meta.url), "utf8");
  const v26 = readFileSync(new URL("./call-session-v26.ts", import.meta.url), "utf8");
  const v50 = readFileSync(new URL("./call-session-v50-reservation-date-scope.ts", import.meta.url), "utf8");
  const reservationDateScopeRuntime = readFileSync(new URL("./reservation-date-scope-runtime.ts", import.meta.url), "utf8");

  assert.match(index, /call-session-v54-close-confirmation-authority/);
  assert.match(v54, /call-session-v53-reservation-time-authority/);
  assert.match(v54, /closingSessionRuntimeFor/);
  assert.match(v54, /closing\.isConfirmationPending\(\)/);
  assert.doesNotMatch(v54, /closingConfirmationPendingV41/);
  assert.match(v54, /CLOSE_CONFIRMATION_AMBIGUOUS_PRESERVED_V54/);
  assert.match(v53, /call-session-v52-trusted-reservation-contact/);
  assert.match(v53, /decideReservationTimeAuthority/);
  assert.match(v53, /RESERVATION_TIME_ASSUMPTION_BLOCKED_V53/);
  assert.match(v52, /call-session-v51-malformed-tool-authority/);
  assert.match(v52, /rewriteReservationCreateContactEvent/);
  assert.match(v51, /malformedToolCorrectionRuntimeFor/);
  assert.match(v51, /adaptRealtimeProviderEvents/);
  assert.match(v51, /runtime\.observe\(this, event\)/);
  assert.doesNotMatch(v51, /decideMalformedToolCorrection/);
  assert.doesNotMatch(v51, /authorizePublicRestaurantToolV29/);
  assert.match(malformedToolCorrectionRuntime, /decideMalformedToolCorrection/);
  assert.match(malformedToolCorrectionRuntime, /ASSISTANT_RESPONSE_STARTED/);
  assert.match(malformedToolCorrectionRuntime, /ASSISTANT_AUDIO_STOPPED/);
  assert.match(malformedToolCorrectionRuntime, /CALLER_SPEECH_STARTED/);
  assert.match(malformedToolCorrectionRuntime, /CALLER_TRANSCRIPT_COMPLETED/);
  assert.match(malformedToolCorrectionRuntime, /SEMANTIC_TOOL_CROSS_TOOL_CORRECTION_BLOCKED_V51/);
  assert.match(malformedToolCorrectionRuntime, /tools:\s*"DISABLED"/);
  assert.match(v36, /turnConcurrencyCoordinatorFor/);
  assert.match(v36, /\.observe\(this as any, parseEvent\(data\)\)/);
  assert.doesNotMatch(v36, /this\.[A-Za-z_$][\w$]*V(?:3[6-9]|4\d|5[0-4])/);
  assert.match(turnConcurrencyCoordinator, /decideTurnConcurrencyAcquire/);
  assert.match(turnConcurrencyCoordinator, /TURN_CONCURRENCY_OLDER_SPLIT_FRAGMENT_DEFERRED_V36/);
  assert.match(v40, /decideIgnoredBargeInPlaybackRecovery/);
  assert.match(v26, /decideDirectPostToolResponse/);
  assert.match(v50, /reservationDateScopeRuntimeFor/);
  assert.match(reservationDateScopeRuntime, /decideReservationDateScope/);
  assert.doesNotMatch(v50, /decideReservationDateScope/);
  assert.doesNotMatch(v51, /setTimeout|sleep\s*\(|delay\s*\(/);
  assert.doesNotMatch(malformedToolCorrectionRuntime, /setTimeout|sleep\s*\(|delay\s*\(/);
  assert.doesNotMatch(v52, /setTimeout|sleep\s*\(|delay\s*\(/);
  assert.doesNotMatch(v53, /setTimeout|sleep\s*\(|delay\s*\(/);
  assert.doesNotMatch(v54, /setTimeout|sleep\s*\(|delay\s*\(/);
});
