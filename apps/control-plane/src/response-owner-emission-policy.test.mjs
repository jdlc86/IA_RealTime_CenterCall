import test from "node:test";
import assert from "node:assert/strict";
import { decideResponseOwnerEmission } from "../.test-dist/response-owner-emission-policy.js";

const runtimeEffects = [
  { type: "cancel_response", responseId: "old" },
  { type: "clear_playback" },
  { type: "create_caller_response" },
];

test("shadow mode cannot execute response owner effects", () => {
  const result = decideResponseOwnerEmission(runtimeEffects, "shadow");
  assert.deepEqual(result.executable, []);
  assert.deepEqual(result.observedOnly, runtimeEffects);
});

test("active mode exposes runtime effects in reducer order", () => {
  const result = decideResponseOwnerEmission(runtimeEffects, "active");
  assert.deepEqual(result.executable, runtimeEffects);
  assert.deepEqual(result.observedOnly, []);
});

test("ownership conflicts are diagnostics and never executable", () => {
  const conflict = {
    type: "response_ownership_conflict",
    previousResponseId: "old",
    newResponseId: "new",
  };
  const result = decideResponseOwnerEmission([conflict, ...runtimeEffects], "active");
  assert.deepEqual(result.executable, runtimeEffects);
  assert.deepEqual(result.observedOnly, [conflict]);
});
