import test from "node:test";
import assert from "node:assert/strict";
import {
  decideBargeInPublicToolRoute,
  decideConfirmedBargeInPromotion,
  decideDeferredBargeInTranscriptRoute,
  decideIgnoredBargeInPlaybackRecovery,
} from "../.test-dist/barge-in-semantic-authority.js";

test("public restaurant tool is deferred while v40 classifies the interruption", () => {
  assert.equal(decideBargeInPublicToolRoute("BARGE_IN_CLASSIFYING"), "DEFER_TO_CLASSIFIER");
});

test("same HOURS tool may enter semantic pipeline after INTERRUPT is confirmed", () => {
  assert.equal(decideBargeInPublicToolRoute("CALLER_TURN_READY"), "ALLOW_SEMANTIC_PIPELINE");
});

test("normal caller turns remain unaffected", () => {
  assert.equal(decideBargeInPublicToolRoute("IDLE"), "ALLOW_SEMANTIC_PIPELINE");
  assert.equal(decideBargeInPublicToolRoute("ASSISTANT_ACTIVE"), "ALLOW_SEMANTIC_PIPELINE");
});

test("confirmed source is promoted immediately when no newer speech item exists", () => {
  assert.equal(decideConfirmedBargeInPromotion("item-a", null), "PROMOTE_SOURCE");
  assert.equal(decideConfirmedBargeInPromotion("item-a", "item-a"), "PROMOTE_SOURCE");
});

test("confirmed older fragment is deferred when a newer speech item already started", () => {
  assert.equal(decideConfirmedBargeInPromotion("item-a", "item-b"), "DEFER_TO_NEWER_SPEECH");
});

test("deferred promotion waits through intermediate fragments and promotes only latest usable transcript", () => {
  assert.equal(decideDeferredBargeInTranscriptRoute("item-c", "item-b", true), "WAIT_FOR_LATEST");
  assert.equal(decideDeferredBargeInTranscriptRoute("item-c", "item-c", true), "PROMOTE_LATEST");
});

test("unusable latest transcript falls back to already-confirmed source without a timer", () => {
  assert.equal(decideDeferredBargeInTranscriptRoute("item-b", "item-b", false), "FALLBACK_SOURCE");
});

test("ignored acoustic candidate stays silent when provider preserved playback", () => {
  assert.equal(decideIgnoredBargeInPlaybackRecovery({
    providerClearedPlaybackBeforeDecision: false,
    terminal: false,
  }), "KEEP_SILENT");
});

test("provider-destructive false barge-in requires bounded liveness recovery instead of dead air", () => {
  assert.equal(decideIgnoredBargeInPlaybackRecovery({
    providerClearedPlaybackBeforeDecision: true,
    terminal: false,
  }), "RECOVER_LIVENESS");
});

test("terminal state never creates playback recovery", () => {
  assert.equal(decideIgnoredBargeInPlaybackRecovery({
    providerClearedPlaybackBeforeDecision: true,
    terminal: true,
  }), "KEEP_SILENT");
});
