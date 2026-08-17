import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeHumanHandoff,
  initialHumanHandoffAuthorizationState,
} from "../.test-dist/human-handoff-authorization-policy.js";

test("model limitation cannot authorize terminal handoff by itself", () => {
  const initial = initialHumanHandoffAuthorizationState();
  const blocked = authorizeHumanHandoff(initial, "Vale, entendido.");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.source, "OFFER_REQUIRED");
  assert.equal(blocked.state.offerPending, true);
});

test("caller can explicitly request a human in the current turn", () => {
  const decision = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Quiero hablar con una persona del equipo");
  assert.equal(decision.allowed, true);
  assert.equal(decision.source, "EXPLICIT_REQUEST");
});

test("caller can accept a previously offered transfer", () => {
  const blocked = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Eso no me lo puedes resolver");
  assert.equal(blocked.allowed, false);
  const confirmed = authorizeHumanHandoff(blocked.state, "Sí");
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.source, "CONFIRMED_OFFER");
});

test("caller rejection clears pending authorization", () => {
  const blocked = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Eso no me lo puedes resolver");
  const rejected = authorizeHumanHandoff(blocked.state, "No, gracias");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.source, "CALLER_REJECTED");
  assert.equal(rejected.state.offerPending, false);
});
