import test from "node:test";
import assert from "node:assert/strict";

import { CallSession as CallSessionV28 } from "../.test-dist/call-session-v28.js";

test("V28 does not own startup provider policy", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(CallSessionV28.prototype, "fetch"),
    false,
    "V28 must not reintroduce a /start override that can emit provider-specific session policy",
  );
});
