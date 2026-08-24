import test from "node:test";
import assert from "node:assert/strict";
import { canonicalControlCommand, governedControlEnvelope } from "./control-sideband.mjs";

test("governed speech preserves every product-owned assistant speech kind", () => {
  assert.deepEqual(
    canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "g-1", text: "Hola", kind: "GREETING" }),
    { type: "GOVERNED_SPEECH", responseId: "g-1", text: "Hola", kind: "GREETING" },
  );
  assert.deepEqual(
    canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "r-1", text: "Seguimos", kind: "RECOVERY" }),
    { type: "GOVERNED_SPEECH", responseId: "r-1", text: "Seguimos", kind: "RECOVERY" },
  );
  for (const kind of ["TERMINAL", "PRESENCE", "HANDOFF"]) {
    assert.deepEqual(
      canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: `${kind}-1`, text: "Texto", kind }),
      { type: "GOVERNED_SPEECH", responseId: `${kind}-1`, text: "Texto", kind },
    );
  }
});

test("governed lifecycle preserves full kind vocabulary", () => {
  for (const kind of ["NORMAL", "GREETING", "RECOVERY", "TERMINAL", "PRESENCE", "HANDOFF"]) {
    assert.deepEqual(governedControlEnvelope({
      type: "ASSISTANT_RESPONSE_COMPLETED",
      responseId: `${kind}-1`,
      kind,
      status: "completed",
    }), {
      type: "GOVERNED_EVENT",
      event: { type: "ASSISTANT_RESPONSE_COMPLETED", responseId: `${kind}-1`, kind, status: "completed" },
    });
  }
});

test("governed speech keeps ordinary speech kindless and rejects unsupported kinds", () => {
  assert.deepEqual(
    canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "n-1", text: "De acuerdo" }),
    { type: "GOVERNED_SPEECH", responseId: "n-1", text: "De acuerdo" },
  );
  assert.throws(
    () => canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "x-1", text: "Adiós", kind: "SEMANTIC" }),
    /kind is unsupported/,
  );
});
