import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyHandoffFailure,
  decodeHumanHandoffClientState,
  encodeHumanHandoffClientState,
  parseHumanHandoffConfig,
} from "../.test-dist/human-handoff.js";

const validConfig = {
  enabled: true,
  destination: { type: "PHONE", phone: "+34910000000", label: "Recepción" },
  transfer: { mode: "BLIND", answerTimeoutSeconds: 25 },
  failurePolicy: {
    action: "TERMINATE_AND_CALLBACK",
    message: "Ahora mismo no ha sido posible comunicarte con una persona del equipo.",
  },
  successMessage: "De acuerdo, te paso con una persona del equipo. Un momento, por favor.",
};

test("human handoff is absent unless configured", () => {
  assert.equal(parseHumanHandoffConfig(undefined), undefined);
});

test("human handoff config validates transversal blind transfer settings", () => {
  assert.deepEqual(parseHumanHandoffConfig(validConfig), validConfig);
});

test("human handoff rejects non-E164 destination", () => {
  assert.throws(
    () => parseHumanHandoffConfig({ ...validConfig, destination: { ...validConfig.destination, phone: "910000000" } }),
    /E\.164/,
  );
});

test("human handoff rejects unsafe transfer timeout", () => {
  assert.throws(
    () => parseHumanHandoffConfig({ ...validConfig, transfer: { mode: "BLIND", answerTimeoutSeconds: 2 } }),
    /answerTimeoutSeconds/,
  );
});

test("Telnyx client state round trips without exposing routing heuristics", () => {
  const state = {
    kind: "human_handoff_v1",
    handoffId: "6ad2b669-e583-4fc1-b4a8-63743a987649",
    realtimeCallId: "rtc_test",
    tenantId: "restaurante-centro",
    sourceCallControlId: "v3:test-control-id",
  };
  const encoded = encodeHumanHandoffClientState(state);
  assert.notEqual(encoded, JSON.stringify(state));
  assert.deepEqual(decodeHumanHandoffClientState(encoded), state);
  assert.equal(decodeHumanHandoffClientState("not-base64-json"), null);
});

test("Telnyx hangup causes map to deterministic callback outcomes", () => {
  assert.equal(classifyHandoffFailure("timeout"), "NO_ANSWER");
  assert.equal(classifyHandoffFailure("no_answer"), "NO_ANSWER");
  assert.equal(classifyHandoffFailure("user_busy"), "BUSY");
  assert.equal(classifyHandoffFailure("call_rejected"), "FAILED");
});
