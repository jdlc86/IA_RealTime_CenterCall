import test from "node:test";
import assert from "node:assert/strict";
import { sidebandCloseLifecycleEvent } from "../.test-dist/sideband-lifecycle-quiescence.js";

test("sideband close is translated into a lifecycle event without timer knowledge", () => {
  assert.deepEqual(sidebandCloseLifecycleEvent("sideband_closed"), {
    type: "transport_closed",
    reason: "sideband_closed",
  });
});
