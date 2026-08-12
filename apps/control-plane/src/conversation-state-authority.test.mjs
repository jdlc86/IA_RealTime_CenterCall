import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeSpecializedFlow } from "../.test-dist/conversation-state-authority.js";

const semantic = (dataRequirement, degraded = false, intent = "CONTINUE") => ({ intent, dataRequirement, degraded, reason: "test" });
const ctx = (overrides = {}) => ({ lifecycleState: "active", hangupStarted: false, reservationInProgress: false, ...overrides });

test("closing is terminal for every specialized flow", () => {
  assert.deepEqual(authorizeSpecializedFlow(ctx({ lifecycleState: "closing" }), semantic("MARKETING_CONSENT")), { flow: null, reason: "CALL_TERMINAL" });
  assert.deepEqual(authorizeSpecializedFlow(ctx({ hangupStarted: true }), semantic("RESERVATION")), { flow: null, reason: "CALL_TERMINAL" });
});

test("active reservation owns degraded CONTINUE turns", () => {
  assert.deepEqual(authorizeSpecializedFlow(ctx({ reservationInProgress: true }), semantic("BUSINESS_INFO", true)), { flow: "RESERVATION", reason: "RESERVATION_OWNS_DEGRADED_TURN" });
});

test("non-degraded explicit topic switch remains classifier-owned", () => {
  assert.deepEqual(authorizeSpecializedFlow(ctx({ reservationInProgress: true }), semantic("MENU", false)), { flow: null, reason: "CORE_ROUTER" });
});

test("clear end remains owned by core even during reservation", () => {
  assert.deepEqual(authorizeSpecializedFlow(ctx({ reservationInProgress: true }), semantic("NONE", false, "END_CLEAR")), { flow: null, reason: "CORE_ROUTER" });
});

test("marketing and reservation route normally while active", () => {
  assert.equal(authorizeSpecializedFlow(ctx(), semantic("MARKETING_CONSENT")).flow, "MARKETING_CONSENT");
  assert.equal(authorizeSpecializedFlow(ctx(), semantic("RESERVATION")).flow, "RESERVATION");
});
