import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeHumanHandoff,
  initialHumanHandoffAuthorizationState,
  isExplicitHumanHandoffRejection,
  observeHumanHandoffCallerTurn,
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
  const observed = observeHumanHandoffCallerTurn(blocked.state, "Sí");
  const confirmed = authorizeHumanHandoff(observed, "Sí");
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.source, "CONFIRMED_OFFER");
});

test("caller rejection clears pending authorization", () => {
  const blocked = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Eso no me lo puedes resolver");
  const observed = observeHumanHandoffCallerTurn(blocked.state, "No, gracias");
  const rejected = authorizeHumanHandoff(observed, "No, gracias");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.source, "CALLER_REJECTED");
  assert.equal(rejected.state.offerPending, false);
});

test("emphatic repeated no is an explicit transfer rejection", () => {
  assert.equal(isExplicitHumanHandoffRejection("no no no"), true);
  assert.equal(isExplicitHumanHandoffRejection("nononono"), true);
  const rejected = authorizeHumanHandoff({ offerPending: true }, "no no no");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.source, "CALLER_REJECTED");
  assert.equal(rejected.state.offerPending, false);
});

test("unrelated caller turn expires an old transfer offer", () => {
  const blocked = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Eso no me lo puedes resolver");
  const afterUnrelatedTurn = observeHumanHandoffCallerTurn(blocked.state, "Otra cosa, ¿tenéis terraza?");
  assert.equal(afterUnrelatedTurn.offerPending, false);
  const laterYes = authorizeHumanHandoff(afterUnrelatedTurn, "Sí");
  assert.equal(laterYes.allowed, false);
  assert.equal(laterYes.source, "OFFER_REQUIRED");
});
