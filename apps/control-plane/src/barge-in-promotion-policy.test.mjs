import test from "node:test";
import assert from "node:assert/strict";
import { planConfirmedBargeInPromotion } from "../.test-dist/barge-in-promotion-policy.js";

test("active response is always cancelled even if SIP already cleared playback", () => {
  assert.deepEqual(planConfirmedBargeInPromotion("resp_123", true), {
    cancelActiveResponse: true,
    clearAudioBuffer: false,
    waitForResponseDone: true,
  });
});

test("active response with live playback is cancelled and audio cleared", () => {
  assert.deepEqual(planConfirmedBargeInPromotion("resp_123", false), {
    cancelActiveResponse: true,
    clearAudioBuffer: true,
    waitForResponseDone: true,
  });
});

test("no active response permits immediate promotion", () => {
  assert.deepEqual(planConfirmedBargeInPromotion(null, true), {
    cancelActiveResponse: false,
    clearAudioBuffer: false,
    waitForResponseDone: false,
  });
});
