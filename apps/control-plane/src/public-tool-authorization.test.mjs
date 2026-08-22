import test from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_RESTAURANT_TOOLS,
  authorizePublicRestaurantTool,
  isPublicRestaurantTool,
} from "../.test-dist/public-tool-authorization.js";

test("human assistance is a public restaurant tool", () => {
  assert.equal(isPublicRestaurantTool("restaurant_human_assistance"), true);
  assert.equal(PUBLIC_RESTAURANT_TOOLS.includes("restaurant_human_assistance"), true);
});

test("natural conversation is a public built-in semantic tool without backend capability", () => {
  assert.equal(isPublicRestaurantTool("restaurant_conversation"), true);
  const decision = authorizePublicRestaurantTool("restaurant_conversation", {}, []);
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "BUILTIN_RUNTIME_TOOL");
});

test("human assistance is always available as a built-in runtime safety/escalation tool", () => {
  const decision = authorizePublicRestaurantTool(
    "restaurant_human_assistance",
    { reason: "USER_REQUESTED_HUMAN" },
    [],
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "BUILTIN_RUNTIME_TOOL");
  assert.deepEqual(decision.requiredCapabilities, []);
});

test("out of scope remains distinct from human assistance", () => {
  const out = authorizePublicRestaurantTool("restaurant_out_of_scope", {}, []);
  const human = authorizePublicRestaurantTool("restaurant_human_assistance", { reason: "COMPLAINT" }, []);
  assert.equal(out.allowed, true);
  assert.equal(human.allowed, true);
  assert.notEqual(out.tool, human.tool);
});
