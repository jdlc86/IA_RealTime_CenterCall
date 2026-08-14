import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptHierarchicalIntentToLegacy } from "../.test-dist/core-intent-legacy-adapter.js";

test("CREATE maps to legacy reservation CREATE without losing fields", () => {
  assert.deepEqual(adaptHierarchicalIntentToLegacy(JSON.stringify({
    intent: "CREATE_RESERVATION",
    reservation: { party_size: 2, starts_at: "2026-08-14T20:00:00+02:00", customer_name: "Juan", confirm: false },
  })), {
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "core_intent_create",
    reservation: { party_size: 2, starts_at: "2026-08-14T20:00:00+02:00", customer_name: "Juan", confirm: false, operation: "CREATE" },
  });
});

test("explicit CREATE confirmation survives hierarchical adapter unchanged", () => {
  assert.deepEqual(adaptHierarchicalIntentToLegacy(JSON.stringify({
    intent: "CREATE_RESERVATION",
    reservation: { confirm: true },
  })), {
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "core_intent_create",
    reservation: { confirm: true, operation: "CREATE" },
  });
});

test("CANCEL maps to existing multi-cancel contract", () => {
  assert.deepEqual(adaptHierarchicalIntentToLegacy(JSON.stringify({
    intent: "CANCEL_RESERVATION",
    reservation: { select_all: true, confirm: true },
  })), {
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "core_intent_cancel",
    reservation: { select_all: true, confirm: true, operation: "CANCEL" },
  });
});

test("QUERY maps to trusted-caller query operation", () => {
  assert.deepEqual(adaptHierarchicalIntentToLegacy(JSON.stringify({ intent: "QUERY_RESERVATION" })), {
    intent: "CONTINUE",
    data_requirement: "RESERVATION",
    reason: "core_intent_query",
    reservation: { operation: "QUERY" },
  });
});

test("marketing payload remains independent", () => {
  assert.deepEqual(adaptHierarchicalIntentToLegacy(JSON.stringify({
    intent: "MARKETING_CONSENT",
    marketing_consent: { action: "GRANT", explicit: true },
  })), {
    intent: "CONTINUE",
    data_requirement: "MARKETING_CONSENT",
    reason: "core_intent_marketing_consent",
    marketing_consent: { action: "GRANT", explicit: true },
  });
});

test("closing maps to existing terminal semantic path only with structured evidence", () => {
  assert.deepEqual(adaptHierarchicalIntentToLegacy(JSON.stringify({
    intent: "CLOSING",
    intent_confidence: 0.99,
    intent_reason_code: "ANSWER_TO_CLOSE_PROMPT",
    conversation: { next_action: "HANGUP_AFTER_SPEECH", closing_signal: "CONFIRMED" },
  })), {
    intent: "END_CLEAR",
    data_requirement: "NONE",
    reason: "core_intent_closing",
  });
});

test("BUSINESS_INFO is handled directly and never squeezed into one legacy requirement", () => {
  assert.equal(adaptHierarchicalIntentToLegacy(JSON.stringify({
    intent: "BUSINESS_INFO",
    business_info: { topics: ["HOURS", "MENU"] },
  })), null);
});
