import assert from "node:assert/strict";
import test from "node:test";
import { resolveSemanticPreselection } from "./semantic-preselection.mjs";
import { GeminiSemanticGateViolation, GeminiSemanticToolGate } from "./semantic-tool-gate.mjs";

const tools = Object.freeze([
  {
    type: "function",
    name: "restaurant_conversation",
    description: "Continue ordinary restaurant conversation.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "restaurant_reservation_search",
    description: "Search existing reservations.",
    parameters: { type: "object", properties: { starts_at: { type: "string" } } },
  },
  {
    type: "function",
    name: "restaurant_reservation_create",
    description: "Create or continue a progressive reservation draft.",
    parameters: {
      type: "object",
      properties: {
        starts_at: { type: "string" },
        party_size: { type: "integer" },
      },
    },
  },
]);

test("deterministic reservation continuation keeps create ownership without reclassifying a short follow-up", async () => {
  let isolatedCalls = 0;
  const bootstrap = Object.freeze({
    instructions: [
      "Base restaurant instructions.",
      "An active reservation draft is waiting only for its date. Interpret the next caller utterance in that reservation context and invoke restaurant_reservation_create progressively.",
    ].join("\n\n"),
    tools,
  });

  const selection = await resolveSemanticPreselection(async () => {
    isolatedCalls += 1;
    return '{"selectedTool":"restaurant_reservation_search"}';
  }, bootstrap, "mañana a las ocho para dos");

  assert.equal(isolatedCalls, 0);
  assert.deepEqual(selection, {
    selectedTool: "restaurant_reservation_create",
    directModelOutputAllowed: false,
  });
});

test("provider create versus stale search preselection reports a stable conflict category", () => {
  const gate = new GeminiSemanticToolGate();
  gate.preArm("gemini-candidate-2");
  gate.preselect("gemini-candidate-2", {
    selectedTool: "restaurant_reservation_search",
    directModelOutputAllowed: false,
  });
  gate.confirmArm();

  assert.throws(
    () => gate.observeProviderMessage({
      toolCall: {
        functionCalls: [{ id: "reservation-create-call-2", name: "restaurant_reservation_create" }],
      },
    }),
    (error) => error instanceof GeminiSemanticGateViolation
      && error.code === "TOOL_PRESELECTION_CONFLICT"
      && /conflicts with isolated preselection/.test(error.message),
  );
});
