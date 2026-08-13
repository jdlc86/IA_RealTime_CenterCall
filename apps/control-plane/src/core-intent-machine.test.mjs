import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialCoreIntentState,
  returnFromAuxiliaryBusinessInfo,
  transitionCoreIntent,
} from "../.test-dist/core-intent-machine.js";

test("routes initial reservation create intent", () => {
  const transition = transitionCoreIntent(initialCoreIntentState(), { intent: "CREATE_RESERVATION" });
  assert.equal(transition.reason, "INITIAL_ROUTE");
  assert.equal(transition.next.workflow, "CREATE_RESERVATION");
});

test("explicit change from create to cancel switches workflow authority", () => {
  const current = { workflow: "CREATE_RESERVATION", suspendedWorkflow: null, businessInfoTopics: [] };
  const transition = transitionCoreIntent(current, { intent: "CANCEL_RESERVATION" });
  assert.equal(transition.reason, "WORKFLOW_SWITCH");
  assert.equal(transition.next.workflow, "CANCEL_RESERVATION");
  assert.equal(transition.next.suspendedWorkflow, null);
});

test("explicit change from cancel to query switches workflow authority", () => {
  const current = { workflow: "CANCEL_RESERVATION", suspendedWorkflow: null, businessInfoTopics: [] };
  const transition = transitionCoreIntent(current, { intent: "QUERY_RESERVATION" });
  assert.equal(transition.reason, "WORKFLOW_SWITCH");
  assert.equal(transition.next.workflow, "QUERY_RESERVATION");
});

test("auxiliary hours query suspends create and returns to it", () => {
  const current = { workflow: "CREATE_RESERVATION", suspendedWorkflow: null, businessInfoTopics: [] };
  const info = transitionCoreIntent(current, {
    intent: "BUSINESS_INFO",
    businessInfoTopics: ["HOURS"],
    auxiliary: true,
  });
  assert.equal(info.reason, "AUXILIARY_INFO_ENTER");
  assert.equal(info.next.workflow, "BUSINESS_INFO");
  assert.equal(info.next.suspendedWorkflow, "CREATE_RESERVATION");
  assert.deepEqual(info.next.businessInfoTopics, ["HOURS"]);

  const resumed = returnFromAuxiliaryBusinessInfo(info.next);
  assert.equal(resumed.reason, "AUXILIARY_INFO_RETURN");
  assert.equal(resumed.next.workflow, "CREATE_RESERVATION");
  assert.equal(resumed.next.suspendedWorkflow, null);
});

test("business info supports several topics in the same turn", () => {
  const transition = transitionCoreIntent(initialCoreIntentState(), {
    intent: "BUSINESS_INFO",
    businessInfoTopics: ["HOURS", "MENU", "HOURS"],
  });
  assert.equal(transition.next.workflow, "BUSINESS_INFO");
  assert.deepEqual(transition.next.businessInfoTopics, ["HOURS", "MENU"]);
});

test("business info without explicit topics falls back to general info", () => {
  const transition = transitionCoreIntent(initialCoreIntentState(), { intent: "BUSINESS_INFO" });
  assert.deepEqual(transition.next.businessInfoTopics, ["GENERAL_INFO"]);
});

test("closing is terminal even if a later operational intent arrives", () => {
  const closing = transitionCoreIntent(initialCoreIntentState(), { intent: "CLOSING" });
  const after = transitionCoreIntent(closing.next, { intent: "CREATE_RESERVATION" });
  assert.equal(after.next.workflow, "CLOSING");
  assert.equal(after.reason, "CLOSE");
});

test("continuing same workflow does not create a new authority transition", () => {
  const current = { workflow: "CREATE_RESERVATION", suspendedWorkflow: null, businessInfoTopics: [] };
  const transition = transitionCoreIntent(current, { intent: "CREATE_RESERVATION" });
  assert.equal(transition.reason, "CONTINUE_CURRENT");
  assert.equal(transition.next.workflow, "CREATE_RESERVATION");
});
