import test from "node:test";
import assert from "node:assert/strict";
import { canonicalControlCommand } from "./control-sideband.mjs";

test("governed speech preserves protected greeting and recovery kinds", () => {
  assert.deepEqual(
    canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "g-1", text: "Hola", kind: "GREETING" }),
    { type: "GOVERNED_SPEECH", responseId: "g-1", text: "Hola", kind: "GREETING" },
  );
  assert.deepEqual(
    canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "r-1", text: "Seguimos", kind: "RECOVERY" }),
    { type: "GOVERNED_SPEECH", responseId: "r-1", text: "Seguimos", kind: "RECOVERY" },
  );
});

test("governed speech keeps ordinary speech kindless and rejects unsupported protected kinds", () => {
  assert.deepEqual(
    canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "n-1", text: "De acuerdo" }),
    { type: "GOVERNED_SPEECH", responseId: "n-1", text: "De acuerdo" },
  );
  assert.throws(
    () => canonicalControlCommand({ type: "GOVERNED_SPEECH", responseId: "x-1", text: "Adiós", kind: "TERMINAL" }),
    /kind is unsupported/,
  );
});
