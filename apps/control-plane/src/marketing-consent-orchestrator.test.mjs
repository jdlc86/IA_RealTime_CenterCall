import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarketingConsentClassifierTurn } from "../.test-dist/marketing-consent-orchestrator.js";

test("explicit grant is parsed as a separate marketing consent fact", () => {
  const turn = parseMarketingConsentClassifierTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "MARKETING_CONSENT",
    reason: "El usuario acepta promociones explícitamente",
    marketing_consent: { action: "GRANT", explicit: true },
  }));
  assert.equal(turn.explicit, true);
  assert.deepEqual(turn.flow, { action: "GRANT", targetPhone: undefined });
});

test("marketing consent without explicit confirmation fails closed", () => {
  assert.throws(
    () => parseMarketingConsentClassifierTurn(JSON.stringify({
      intent: "CONTINUE",
      data_requirement: "MARKETING_CONSENT",
      reason: "No existe un sí explícito",
      marketing_consent: { action: "GRANT", explicit: false },
    })),
    /Explicit marketing consent is required/,
  );
});

test("missing marketing consent payload fails closed", () => {
  assert.throws(
    () => parseMarketingConsentClassifierTurn(JSON.stringify({
      intent: "CONTINUE",
      data_requirement: "MARKETING_CONSENT",
      reason: "Falta el payload",
    })),
    /Expected object/,
  );
});

test("verbally supplied target phone remains only a requested target, never caller proof", () => {
  const turn = parseMarketingConsentClassifierTurn(JSON.stringify({
    intent: "CONTINUE",
    data_requirement: "MARKETING_CONSENT",
    reason: "El usuario pide gestionar otro número",
    marketing_consent: { action: "REVOKE", explicit: true, target_phone: "+34622222222" },
  }));
  assert.deepEqual(turn.flow, { action: "REVOKE", targetPhone: "+34622222222" });
});

test("unexpected classifier fields are rejected", () => {
  assert.throws(
    () => parseMarketingConsentClassifierTurn(JSON.stringify({
      intent: "CONTINUE",
      data_requirement: "MARKETING_CONSENT",
      reason: "Intento de ampliar autoridad",
      marketing_consent: { action: "GRANT", explicit: true, caller_verified: true },
    })),
    /Unexpected marketing consent classifier field/,
  );
});
