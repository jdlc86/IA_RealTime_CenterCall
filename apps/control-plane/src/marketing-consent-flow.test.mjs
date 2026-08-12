import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideCallerMatchConsent,
  validateMarketingConsentFlowArgs,
} from "../.test-dist/marketing-consent-flow.js";

test("grant is allowed only for the inbound caller number", () => {
  const args = validateMarketingConsentFlowArgs({ action: "GRANT", target_phone: "+34612345678" });
  assert.deepEqual(decideCallerMatchConsent(args, "+34612345678"), {
    allowed: true,
    stage: "CONSENT_READY",
    action: "GRANT",
    phone: "+34612345678",
    verificationMethod: "CALLER_ID_MATCH",
  });
});

test("caller A cannot grant marketing for phone B", () => {
  const args = validateMarketingConsentFlowArgs({ action: "GRANT", target_phone: "+34622222222" });
  const result = decideCallerMatchConsent(args, "+34611111111");
  assert.equal(result.allowed, false);
  assert.equal(result.stage, "OTHER_PHONE_REQUIRES_ALTERNATIVE");
});

test("caller A cannot revoke phone B automatically", () => {
  const args = validateMarketingConsentFlowArgs({ action: "REVOKE", target_phone: "+34622222222" });
  const result = decideCallerMatchConsent(args, "+34611111111");
  assert.equal(result.allowed, false);
  assert.equal(result.stage, "OTHER_PHONE_REQUIRES_ALTERNATIVE");
});

test("revoke without target applies to the inbound caller number", () => {
  const args = validateMarketingConsentFlowArgs({ action: "REVOKE" });
  const result = decideCallerMatchConsent(args, "+34611111111");
  assert.equal(result.allowed, true);
  assert.equal(result.phone, "+34611111111");
});

test("missing caller number fails closed", () => {
  const args = validateMarketingConsentFlowArgs({ action: "GRANT" });
  const result = decideCallerMatchConsent(args, null);
  assert.equal(result.allowed, false);
  assert.equal(result.stage, "CALLER_NUMBER_UNAVAILABLE");
});

test("invalid target phone is rejected before any write", () => {
  assert.throws(() => validateMarketingConsentFlowArgs({ action: "GRANT", target_phone: "612345678" }), /Invalid phone number/);
});
