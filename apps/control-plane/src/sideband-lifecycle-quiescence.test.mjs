import test from "node:test";
import assert from "node:assert/strict";
import { sidebandCloseQuiescenceActions } from "../.test-dist/sideband-lifecycle-quiescence.js";

test("sideband close quiesces every realtime-dependent conversation deadline", () => {
  assert.deepEqual(sidebandCloseQuiescenceActions(), [
    "CLEAR_PRESENCE_TIMER",
    "CLEAR_SILENCE_CLOSE_TIMER",
    "CLEAR_MAX_CALL_TIMER",
    "CLEAR_PRESENCE_RESPONSE_STATE",
  ]);
});
